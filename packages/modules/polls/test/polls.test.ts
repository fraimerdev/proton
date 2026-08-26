import { describe, expect, test } from 'bun:test';
import { limitFor, Permissions, POLL_MAX_ANSWERS } from '@proton/core';
import { ANNOUNCE_JOB, announceKey } from '../src/announce.ts';
import { POLL_DEFAULT_DURATION_HOURS } from '../src/config.ts';
import {
  ANNOUNCE_CHANNEL,
  BOT,
  booleanOption,
  CHANNEL,
  FULL_PERMISSIONS,
  GUILD,
  harness,
  integerOption,
  MEMBER,
  POLL_MESSAGE,
  stringOption,
} from './harness.ts';

const CREATE = [stringOption('question', 'Best topping?'), stringOption('answers', 'Olive | Fig')];

const HOUR_MS = 3_600_000;

function seedPoll(
  h: ReturnType<typeof harness>,
  overrides: Partial<{
    messageId: string;
    endsAt: Date;
    endedAt: Date | null;
    announceChannelId: string | null;
  }> = {},
) {
  const messageId = overrides.messageId ?? POLL_MESSAGE;

  h.polls.rows.set(`${GUILD}:${messageId}`, {
    guildId: GUILD,
    channelId: CHANNEL,
    messageId,
    createdBy: MEMBER,
    question: 'Best topping?',
    endsAt: overrides.endsAt ?? new Date(Date.now() + HOUR_MS),
    endedAt: overrides.endedAt ?? null,
    announceChannelId: overrides.announceChannelId ?? null,
    createdAt: new Date(Date.now() - HOUR_MS),
  });

  return messageId;
}

describe('/poll create', () => {
  test('POSTs a native poll whose body is the shape Discord documents', async () => {
    const h = harness();

    await h.run('create', [
      ...CREATE,
      integerOption('duration_hours', 6),
      booleanOption('multiple', true),
    ]);

    const sent = h.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/channels/${CHANNEL}/messages`);
    expect(sent[0]?.body.poll).toEqual({
      question: { text: 'Best topping?' },
      answers: [{ poll_media: { text: 'Olive' } }, { poll_media: { text: 'Fig' } }],
      duration: 6,
      allow_multiselect: true,
    });
  });

  test('acknowledges the interaction before it talks to Discord', async () => {
    const h = harness();

    await h.run('create', CREATE);

    const paths = h.calls().map((call) => call.path);
    expect(paths[0]).toBe(`/interactions/600000000000000001/interaction-token/callback`);
    expect(paths.indexOf(`/channels/${CHANNEL}/messages`)).toBeGreaterThan(0);
  });

  test('takes the message id from the result body and records the poll', async () => {
    const h = harness();
    h.rest.nextMessageId = '700000000000000009';

    await h.run('create', CREATE);

    const stored = await h.polls.get(GUILD, '700000000000000009');
    expect(stored).toMatchObject({
      channelId: CHANNEL,
      createdBy: MEMBER,
      question: 'Best topping?',
      endedAt: null,
      announceChannelId: null,
    });
    expect(h.lastAnswer()).toContain('700000000000000009');
  });

  test('uses the server’s default duration when none is given', async () => {
    const h = harness();

    await h.run('create', CREATE, { config: { defaultDurationHours: 3 } });

    expect(h.sent()[0]?.body.poll?.duration).toBe(3);

    const stored = await h.polls.get(GUILD, POLL_MESSAGE);
    const hours = ((stored?.endsAt.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(2.9);
    expect(hours).toBeLessThan(3.1);
  });

  test('books the announce schedule under the message id, for the deadline', async () => {
    const h = harness();

    await h.run('create', CREATE);

    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]).toMatchObject({
      jobId: ANNOUNCE_JOB,
      naturalKey: POLL_MESSAGE,
      data: { messageId: POLL_MESSAGE },
      options: { replace: true },
    });

    const stored = await h.polls.get(GUILD, POLL_MESSAGE);
    expect(h.scheduled[0]?.runAt.getTime()).toBe(stored?.endsAt.getTime());
  });

  test('books the closing job even when announcements are off, so the row cannot leak', async () => {
    const h = harness();

    await h.run('create', CREATE, { config: { announceResults: false } });

    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.naturalKey).toBe(POLL_MESSAGE);
  });

  test('remembers the announce channel the poll was started under', async () => {
    const h = harness();

    await h.run('create', CREATE, { config: { announceChannelId: ANNOUNCE_CHANNEL } });

    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.announceChannelId).toBe(ANNOUNCE_CHANNEL);
  });

  test('names the consequence when the deployment has no scheduler', async () => {
    const h = harness();

    await h.run('create', CREATE, { withoutScheduler: true });

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('running-poll limit');
    expect(answer).toContain('/poll end');
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('schedule'))).toBe(
      true,
    );
    expect(await h.polls.get(GUILD, POLL_MESSAGE)).not.toBeNull();
  });

  test('names the consequence when the schedule was refused', async () => {
    const h = harness();

    await h.run('create', CREATE, { scheduleOutcome: { scheduled: false, replaced: false } });

    expect(h.lastAnswer()).toContain('running-poll limit');
    expect(h.logs.some((line) => line.level === 'warn')).toBe(true);
  });

  test('names the answer cap and never reaches Discord', async () => {
    const h = harness();
    const answers = Array.from({ length: POLL_MAX_ANSWERS + 1 }, (_, i) => `a${i}`).join('|');

    await h.run('create', [stringOption('question', 'q'), stringOption('answers', answers)]);

    expect(h.sent()).toHaveLength(0);
    expect(h.polls.rows.size).toBe(0);
    expect(h.lastAnswer()).toContain(String(POLL_MAX_ANSWERS));
  });

  test('names the missing permission when the bot cannot send polls', async () => {
    const h = harness();

    await h.run('create', CREATE, {
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(h.sent()).toHaveLength(0);
    expect(h.polls.rows.size).toBe(0);

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('Create Polls');
    expect(answer).toContain(CHANNEL);
  });

  test('says the poll did not go out, in Proton’s own words', async () => {
    const h = harness();
    h.rest.failures.push({
      match: /^\/channels\/\d+\/messages$/,
      status: 403,
      body: { message: 'Missing Access' },
    });

    await h.run('create', CREATE);

    expect(h.polls.rows.size).toBe(0);
    expect(h.lastAnswer()).toContain('I could not post that poll');
  });

  test('says so rather than pretending when Discord returns no message id', async () => {
    const h = harness();
    h.rest.nextMessageId = null;

    await h.run('create', CREATE);

    expect(h.polls.rows.size).toBe(0);
    expect(h.scheduled).toHaveLength(0);
    expect(h.lastAnswer()).toContain('did not tell me which message');
    expect(h.logs.some((line) => line.level === 'error')).toBe(true);
  });

  test('refuses at the free tier limit, naming the tier, the number and the way out', async () => {
    const h = harness();
    const cap = limitFor('free', 'activePolls');

    for (let index = 0; index < cap; index++) {
      seedPoll(h, { messageId: `70000000000000000${index}` });
    }

    await h.run('create', CREATE);

    expect(h.sent()).toHaveLength(0);

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('free');
    expect(answer).toContain(String(cap));
    expect(answer).toContain('plus');
    expect(answer).toContain('/poll end');
  });

  test('a closed poll stops counting against the limit', async () => {
    const h = harness();

    for (let index = 0; index < limitFor('free', 'activePolls'); index++) {
      seedPoll(h, { messageId: `70000000000000000${index}`, endedAt: new Date() });
    }

    await h.run('create', CREATE);

    expect(h.sent()).toHaveLength(1);
  });

  test('a poll past its deadline stops counting, so the limit cannot be held for ever', async () => {
    const h = harness();

    for (let index = 0; index < limitFor('free', 'activePolls'); index++) {
      seedPoll(h, {
        messageId: `70000000000000000${index}`,
        endsAt: new Date(Date.now() - HOUR_MS),
      });
    }

    await h.run('create', CREATE);

    expect(h.sent()).toHaveLength(1);
  });

  test('a plus guild gets the plus allowance', async () => {
    const h = harness();

    for (let index = 0; index < limitFor('free', 'activePolls'); index++) {
      seedPoll(h, { messageId: `70000000000000000${index}` });
    }

    await h.run('create', CREATE, { tier: 'plus' });

    expect(h.sent()).toHaveLength(1);
  });

  test('a redelivered interaction posts one poll and answers once', async () => {
    const h = harness();
    const idempotencyKey = 'replayed-create';

    await h.run('create', CREATE, { idempotencyKey });
    const afterFirst = h.calls().length;

    await h.run('create', CREATE, { idempotencyKey });

    expect(h.sent()).toHaveLength(1);
    expect(h.polls.rows.size).toBe(1);
    expect(h.calls()).toHaveLength(afterFirst);
  });

  test('a retry that crashed after posting says so instead of posting a second poll', async () => {
    const h = harness();
    const idempotencyKey = 'crashed-create';

    await h.run('create', CREATE, { idempotencyKey });

    await h.dedupe.release(`${idempotencyKey}:defer`);
    await h.dedupe.release(`${idempotencyKey}:followup`);

    await h.run('create', CREATE, { idempotencyKey });

    expect(h.sent()).toHaveLength(1);
    expect(h.polls.rows.size).toBe(1);
    expect(h.lastAnswer()).toContain('already posted');
  });

  test('names the missing wiring when the module was built without its ports', async () => {
    const h = harness();

    await h.run('create', CREATE, { deps: {} });

    expect(h.sent()).toHaveLength(0);
    expect(h.lastAnswer()).toContain("isn't fully wired up");

    const logged = h.logs.find((line) => line.level === 'error')?.message ?? '';
    expect(logged).toContain('store');
    expect(logged).toContain('applicationId');
  });

  test('starting a poll is not a moderation case', async () => {
    const h = harness();

    await h.run('create', CREATE);

    expect(h.recorder.recorded).toHaveLength(0);
  });
});

describe('/poll end', () => {
  test('expires the poll through Discord’s own endpoint', async () => {
    const h = harness();
    seedPoll(h);

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    const expire = h.calls().find((call) => call.path.endsWith('/expire'));
    expect(expire?.method).toBe('POST');
    expect(expire?.path).toBe(`/channels/${CHANNEL}/polls/${POLL_MESSAGE}/expire`);
  });

  test('refuses a poll it did not send, and says why', async () => {
    const h = harness();

    await h.run('end', [stringOption('message_id', '700000000000000042')]);

    expect(h.calls().some((call) => call.path.endsWith('/expire'))).toBe(false);

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('700000000000000042');
    expect(answer).toContain('only lets an application close a poll it sent itself');
    expect(answer).toContain('/poll list');
  });

  test('refuses something that is not a message id at all', async () => {
    const h = harness();

    await h.run('end', [stringOption('message_id', 'the pizza one')]);

    expect(h.calls().some((call) => call.path.endsWith('/expire'))).toBe(false);
    expect(h.lastAnswer()).toContain('Developer Mode');
  });

  test('says a poll already closed instead of expiring it twice', async () => {
    const h = harness();
    seedPoll(h, { endedAt: new Date('2026-08-17T12:00:00.000Z') });

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    expect(h.calls().some((call) => call.path.endsWith('/expire'))).toBe(false);
    expect(h.lastAnswer()).toContain('already closed');
  });

  test('marks the row ended, cancels the deadline job and announces once', async () => {
    const h = harness();
    seedPoll(h);

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.endedAt).not.toBeNull();
    expect(h.cancelled).toEqual([{ jobId: ANNOUNCE_JOB, naturalKey: POLL_MESSAGE }]);
    expect(h.sent()).toHaveLength(1);
    expect(h.sent()[0]?.body.content).toContain('Poll closed');
  });

  test('the deadline job that survives an early end announces nothing more', async () => {
    const h = harness();
    seedPoll(h);

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);
    await h.announce({ messageId: POLL_MESSAGE });

    expect(h.sent()).toHaveLength(1);
  });

  test('leaves the poll running and says how the slot frees when Discord refuses', async () => {
    const h = harness();
    seedPoll(h);
    h.rest.failures.push({
      match: /\/expire$/,
      status: 403,
      body: { message: 'Missing Access' },
    });

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.endedAt).toBeNull();
    expect(h.cancelled).toHaveLength(0);

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('I could not close that poll');
    expect(answer).toContain('running-poll limit');
    expect(answer).toContain('closes itself');
  });

  test('closes the row when the poll message is gone, so the slot is released', async () => {
    const h = harness();
    seedPoll(h);
    h.rest.failures.push({
      match: /\/expire$/,
      status: 404,
      body: { message: 'Unknown Message' },
    });

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.endedAt).not.toBeNull();
    expect(h.cancelled).toEqual([{ jobId: ANNOUNCE_JOB, naturalKey: POLL_MESSAGE }]);

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('deleted');
    expect(answer).toContain('running-poll limit');
  });

  test('closes a poll whose clock already ran out instead of asking Discord to expire it', async () => {
    const h = harness();
    seedPoll(h, { endsAt: new Date(Date.now() - HOUR_MS) });

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    expect(h.calls().some((call) => call.path.endsWith('/expire'))).toBe(false);
    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.endedAt).not.toBeNull();
    expect(h.cancelled).toEqual([{ jobId: ANNOUNCE_JOB, naturalKey: POLL_MESSAGE }]);
    expect(h.lastAnswer()).toContain('running-poll limit');
  });

  test('ending a poll is not a moderation case', async () => {
    const h = harness();
    seedPoll(h);

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)]);

    expect(h.recorder.recorded).toHaveLength(0);
  });
});

describe('/poll list', () => {
  test('answers with the running polls in one call, without deferring', async () => {
    const h = harness();
    seedPoll(h);
    seedPoll(h, { messageId: '700000000000000002', endedAt: new Date() });

    await h.run('list', []);

    expect(h.calls()).toHaveLength(1);
    expect(h.lastAnswer()).toContain(POLL_MESSAGE);
    expect(h.lastAnswer()).not.toContain('700000000000000002');
  });

  test('says the server has none rather than answering with an empty list', async () => {
    const h = harness();

    await h.run('list', []);

    expect(h.lastAnswer()).toContain('No polls are running');
  });

  test('cannot be made to ping the server through a poll question', async () => {
    const h = harness();
    h.polls.rows.set(`${GUILD}:${POLL_MESSAGE}`, {
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: POLL_MESSAGE,
      createdBy: MEMBER,
      question: '@everyone vote now',
      endsAt: new Date('2026-08-18T10:00:00.000Z'),
      endedAt: null,
      announceChannelId: null,
      createdAt: new Date(),
    });

    await h.run('list', []);

    expect(h.bodies()[0]?.data?.allowed_mentions).toEqual({ parse: [] });
  });

  test('names the missing wiring without needing the application id', async () => {
    const h = harness();

    await h.run('list', [], { deps: { applicationId: BOT } });

    expect(h.lastAnswer()).toContain("isn't fully wired up");
  });
});

describe('the announce schedule', () => {
  test('marks the poll ended and posts one note linking it', async () => {
    const h = harness();
    seedPoll(h);

    await h.announce({ messageId: POLL_MESSAGE });

    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.endedAt).not.toBeNull();

    const sent = h.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/channels/${CHANNEL}/messages`);
    expect(sent[0]?.body.content).toContain(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${POLL_MESSAGE}`,
    );
    expect(sent[0]?.body.content).toContain('cannot read it back');
    expect(sent[0]?.body.allowed_mentions).toEqual({ parse: [] });
  });

  test('announces a poll whose row was closed by a delivery that died before announcing', async () => {
    const h = harness();
    seedPoll(h, { endedAt: new Date(Date.now() - 1_000) });

    await h.announce({ messageId: POLL_MESSAGE });

    const sent = h.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.content).toContain('Poll closed');
  });

  test('is a no-op on redelivery', async () => {
    const h = harness();
    seedPoll(h);

    await h.announce({ messageId: POLL_MESSAGE });
    await h.announce({ messageId: POLL_MESSAGE });
    await h.announce({ messageId: POLL_MESSAGE });

    expect(h.sent()).toHaveLength(1);
  });

  test('the idempotency key is the poll, not the delivery that triggered it', async () => {
    const h = harness();
    seedPoll(h);

    await h.announce({ messageId: POLL_MESSAGE });

    expect(await h.polls.get(GUILD, POLL_MESSAGE)).not.toBeNull();
    expect(announceKey(GUILD, POLL_MESSAGE)).toBe(`polls:${GUILD}:${POLL_MESSAGE}:announce`);
  });

  test('posts to the announce channel the poll was started under', async () => {
    const h = harness();
    seedPoll(h, { announceChannelId: ANNOUNCE_CHANNEL });

    await h.announce({ messageId: POLL_MESSAGE });

    expect(h.sent()[0]?.path).toBe(`/channels/${ANNOUNCE_CHANNEL}/messages`);
  });

  test('still closes the poll when the server turned announcements off', async () => {
    const h = harness();
    seedPoll(h);

    await h.announce({ messageId: POLL_MESSAGE }, { config: { announceResults: false } });

    expect((await h.polls.get(GUILD, POLL_MESSAGE))?.endedAt).not.toBeNull();
    expect(h.sent()).toHaveLength(0);
  });

  test('names the channel and the permission when it cannot post the note', async () => {
    const h = harness();
    seedPoll(h, { announceChannelId: ANNOUNCE_CHANNEL });

    await h.announce({ messageId: POLL_MESSAGE }, { botPermissions: Permissions.ViewChannel });

    const logged = h.logs.find((line) => line.level === 'error')?.message ?? '';
    expect(logged).toContain(ANNOUNCE_CHANNEL);
    expect(logged).toContain('Send Messages');
    expect(logged).toContain('poll itself is unaffected');
  });

  test('logs and stops when the poll row is gone', async () => {
    const h = harness();

    await h.announce({ messageId: POLL_MESSAGE });

    expect(h.sent()).toHaveLength(0);
    expect(h.logs.some((line) => line.message.includes('no longer in this server'))).toBe(true);
  });

  test('logs and stops when the schedule carries no usable message id', async () => {
    const h = harness();

    await h.announce({ messageId: 'not-a-snowflake' });

    expect(h.sent()).toHaveLength(0);
    expect(h.logs.some((line) => line.level === 'error')).toBe(true);
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();

    await h.announce({ messageId: POLL_MESSAGE }, { deps: {} });

    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('store'))).toBe(
      true,
    );
  });

  test('announcing a poll is not a moderation case', async () => {
    const h = harness();
    seedPoll(h);

    await h.announce({ messageId: POLL_MESSAGE });

    expect(h.recorder.recorded).toHaveLength(0);
  });
});

describe('the manifest’s own rails', () => {
  test('the bot is invited with everything the poll payload needs', async () => {
    const h = harness();

    await h.run('create', CREATE, { botPermissions: FULL_PERMISSIONS });

    expect(h.sent()).toHaveLength(1);
    expect(POLL_DEFAULT_DURATION_HOURS).toBe(24);
  });
});
