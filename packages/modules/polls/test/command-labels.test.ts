import { describe, expect, test } from 'bun:test';
import { type CommandLabeler, formatCommandLabel, limitFor } from '@proton/core';
import { renderRunning } from '../src/commands.ts';
import { CHANNEL, GUILD, harness, MEMBER, POLL_MESSAGE, stringOption } from './harness.ts';

const CREATE = [stringOption('question', 'Best topping?'), stringOption('answers', 'Olive | Fig')];

const renamed: CommandLabeler = (key, path) =>
  formatCommandLabel(key, path, key === 'poll' ? 'vote' : undefined);

function seedPoll(h: ReturnType<typeof harness>, messageId = POLL_MESSAGE): void {
  h.polls.rows.set(`${GUILD}:${messageId}`, {
    guildId: GUILD,
    channelId: CHANNEL,
    messageId,
    createdBy: MEMBER,
    question: 'Best topping?',
    endsAt: new Date(Date.now() + 3_600_000),
    endedAt: null,
    announceChannelId: null,
    createdAt: new Date(Date.now() - 3_600_000),
  });
}

describe('polls name /poll as the server shows it', () => {
  test('a posted poll says how to close it with the renamed command', async () => {
    const h = harness();

    await h.run('create', CREATE, { commandLabel: renamed });

    expect(h.lastAnswer()).toContain(
      `To close it sooner: \`/vote end message_id:${POLL_MESSAGE}\`.`,
    );
  });

  test('without a label source a posted poll keeps /poll', async () => {
    const h = harness();

    await h.run('create', CREATE);

    expect(h.lastAnswer()).toContain(
      `To close it sooner: \`/poll end message_id:${POLL_MESSAGE}\`.`,
    );
  });

  test('an unbooked closing job names the renamed end command', async () => {
    const h = harness();

    await h.run('create', CREATE, { withoutScheduler: true, commandLabel: renamed });

    expect(h.lastAnswer()).toContain('until someone runs `/vote end` on it.');
  });

  test('the limit refusal names the renamed end command', async () => {
    const h = harness();
    for (let index = 0; index < limitFor('free', 'activePolls'); index++) {
      seedPoll(h, `70000000000000000${index}`);
    }

    await h.run('create', CREATE, { commandLabel: renamed });

    expect(h.lastAnswer()).toContain('Close one early with `/vote end`.');
  });

  test('a repeated create names the renamed list command', async () => {
    const h = harness();
    const idempotencyKey = 'crashed-create';

    await h.run('create', CREATE, { idempotencyKey });
    await h.dedupe.release(`${idempotencyKey}:defer`);
    await h.dedupe.release(`${idempotencyKey}:followup`);
    await h.run('create', CREATE, { idempotencyKey, commandLabel: renamed });

    expect(h.lastAnswer()).toContain('See what’s running with `/vote list`.');
  });

  test('a malformed message id points at the renamed list command', async () => {
    const h = harness();

    await h.run('end', [stringOption('message_id', 'not-an-id')], { commandLabel: renamed });

    expect(h.lastAnswer()).toContain('Take one from `/vote list`');
  });

  test('a poll Proton did not send names every renamed command', async () => {
    const h = harness();

    await h.run('end', [stringOption('message_id', '700000000000000042')], {
      commandLabel: renamed,
    });

    const answer = h.lastAnswer() ?? '';
    expect(answer).toContain('so `/vote end` only works on polls started with `/vote create`');
    expect(answer).toContain('`/vote list` shows the ones I can close.');
    expect(answer).not.toContain('/poll');
  });

  test('a refused close says to run the renamed end command again', async () => {
    const h = harness();
    seedPoll(h);
    h.rest.failures.push({ match: /\/expire$/, status: 403, body: { message: 'Missing Access' } });

    await h.run('end', [stringOption('message_id', POLL_MESSAGE)], { commandLabel: renamed });

    expect(h.lastAnswer()).toContain(`run \`/vote end message_id:${POLL_MESSAGE}\` again`);
  });

  test('an empty list names the renamed create command', async () => {
    const h = harness();

    await h.run('list', [], { commandLabel: renamed });

    expect(h.lastAnswer()).toContain('Start one with `/vote create`.');
  });

  test('renderRunning names the renamed command and falls back to /poll', () => {
    expect(renderRunning([], GUILD, { commandLabel: renamed })).toContain(
      'Start one with `/vote create`.',
    );
    expect(renderRunning([], GUILD)).toContain('Start one with `/poll create`.');
  });
});
