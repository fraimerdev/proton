import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { DELETE_SECONDS_MAX } from '../src/config.ts';
import { HONEYPOT_ALARM, HONEYPOT_OK } from '../src/embed.ts';
import type { TrapOutcome } from '../src/listener.ts';
import { HONEYPOT_COLOUR } from '../src/notice.ts';
import {
  ABOVE,
  armed,
  BOT_PERMISSIONS,
  GUILD,
  harness,
  LOG,
  MEMBER,
  MESSAGE,
  OTHER,
  THREAD,
  TRAP,
} from './harness.ts';

const BAN = `PUT /guilds/${GUILD}/bans/${MEMBER}`;
const UNBAN = `DELETE /guilds/${GUILD}/bans/${MEMBER}`;
const DELETE_TRIGGER = `DELETE /channels/${TRAP}/messages/${MESSAGE}`;

function refusal(outcome: TrapOutcome): string {
  if (outcome.action !== 'refused') {
    throw new Error(`expected the trap to be refused, but it came back '${outcome.action}'`);
  }
  return outcome.reason;
}

function fieldsOf(embed: Record<string, unknown> | null): Map<string, string> {
  const fields = Array.isArray(embed?.fields) ? embed.fields : [];
  return new Map(
    (fields as Array<{ name: string; value: string }>).map((field) => [field.name, field.value]),
  );
}

describe('the softban', () => {
  test('bans with the configured window and then lifts it, in that order', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed() });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.calls()).toEqual([BAN, UNBAN]);
    expect(h.bodyOf('PUT', `/guilds/${GUILD}/bans/${MEMBER}`)).toEqual({
      delete_message_seconds: DELETE_SECONDS_MAX,
    });
  });

  test('carries the window the row was configured with, not the default', async () => {
    const h = harness();

    await h.trip({ config: armed({ deleteMessageSeconds: 3600 }) });

    expect(h.bodyOf('PUT', `/guilds/${GUILD}/bans/${MEMBER}`)).toEqual({
      delete_message_seconds: 3600,
    });
  });

  test('claims a different idempotency key for the ban and for the lift', async () => {
    const h = harness();

    await h.trip({ config: armed() });

    expect(h.keys()).toHaveLength(2);
    expect(new Set(h.keys()).size).toBe(2);
  });

  test('writes one case, because one trap is one punishment', async () => {
    const h = harness();

    await h.trip({ config: armed() });

    expect(h.cases().map((entry) => entry.kind)).toEqual(['ban']);
  });
});

describe('each action kind', () => {
  test('ban removes the member and never lifts it', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed({ action: 'ban' }) });

    expect(outcome).toEqual({ action: 'sprung', kind: 'ban' });
    expect(h.calls()).toEqual([BAN]);
  });

  test('kick removes the member and deletes what they posted', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed({ action: 'kick' }) });

    expect(outcome).toEqual({ action: 'sprung', kind: 'kick' });
    expect(h.calls()).toEqual([`DELETE /guilds/${GUILD}/members/${MEMBER}`, DELETE_TRIGGER]);
  });

  test('timeout silences the member for the configured length', async () => {
    const h = harness();

    await h.trip({ config: armed({ action: 'timeout', timeoutDuration: '10m' }) });

    const body = h.bodyOf('PATCH', `/guilds/${GUILD}/members/${MEMBER}`);
    expect(Date.parse(String(body?.communication_disabled_until))).toBe(h.now() + 600_000);
    expect(h.calls()).toContain(DELETE_TRIGGER);
  });

  test('warn touches Discord only to delete the message, and still writes the case', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed({ action: 'warn' }) });

    expect(outcome).toEqual({ action: 'sprung', kind: 'warn' });
    expect(h.calls()).toEqual([DELETE_TRIGGER]);
    expect(h.cases().map((entry) => entry.kind)).toEqual(['warn']);
  });

  test('none does nothing to the member but still deletes the message and still logs', async () => {
    const h = harness();

    const outcome = await h.trip({ config: { ...armed({ action: 'none' }), logChannelId: LOG } });

    expect(outcome).toEqual({ action: 'sprung', kind: 'none' });
    expect(h.calls()).toEqual([DELETE_TRIGGER, `POST /channels/${LOG}/messages`]);
    expect(h.cases()).toEqual([]);
    expect(h.embedIn(LOG)?.title).toContain('Honeypot triggered');
  });
});

describe('the message that sprang the trap', () => {
  test('is left to the ban window for a softban', async () => {
    const h = harness();

    await h.trip({ config: armed() });

    expect(h.deleted()).toEqual([]);
  });

  test('is left to the ban window for a ban', async () => {
    const h = harness();

    await h.trip({ config: armed({ action: 'ban' }) });

    expect(h.deleted()).toEqual([]);
  });

  test('is deleted when the window is zero, because that window purges nothing', async () => {
    const h = harness();

    await h.trip({ config: armed({ deleteMessageSeconds: 0 }) });

    expect(h.deleted()).toEqual([`${TRAP}/${MESSAGE}`]);
  });
});

describe('a burst', () => {
  test('produces exactly one ban, and tells the caller the rest were held', async () => {
    const h = harness();

    // Three distinct message ids: reusing one would be held by the executor's dedupe instead, and
    // the lock this test exists to prove would never be reached.
    const first = await h.trip({ config: armed(), messageId: '1400000000000000001' });
    const second = await h.trip({ config: armed(), messageId: '1400000000000000002' });
    const third = await h.trip({ config: armed(), messageId: '1400000000000000003' });

    expect(first).toEqual({ action: 'sprung', kind: 'softban' });
    expect(second).toEqual({
      action: 'held',
      reason: 'this member already tripped a honeypot moments ago',
    });
    expect(third).toEqual(second);

    expect(h.lock.attempts).toHaveLength(3);
    expect(h.calls().filter((call) => call === BAN)).toHaveLength(1);
  });

  test('holds the member who tripped it, not everyone else in the server', async () => {
    const h = harness();

    await h.trip({ config: armed() });
    const other = await h.trip({
      config: armed(),
      authorId: OTHER,
      messageId: '1400000000000000002',
    });

    expect(other).toEqual({ action: 'sprung', kind: 'softban' });
  });
});

describe('threads', () => {
  test('a message under a honeypot channel trips it', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), channelId: THREAD });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.calls()).toContain(BAN);
  });

  test('does not trip it when threads are switched off', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: { ...armed(), includeThreads: false },
      channelId: THREAD,
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'not a honeypot channel' });
    expect(h.calls()).toEqual([]);
  });
});

describe('the incident log', () => {
  test('reaches the log channel with the window and the result on it', async () => {
    const h = harness();

    await h.trip({ config: { ...armed(), logChannelId: LOG } });

    const embed = h.embedIn(LOG);
    expect(embed?.color).toBe(HONEYPOT_OK);

    const fields = fieldsOf(embed);
    expect(fields.get('Action')).toBe('Softban');
    expect(fields.get('Messages deleted')).toBe('the last 7 days');
    expect(fields.get('Result')).toBe('Done');
  });

  test('is skipped entirely when no log channel is set', async () => {
    const h = harness();

    await h.trip({ config: armed() });

    expect(h.sentIn(LOG)).toEqual([]);
    expect(h.calls().some((call) => call.startsWith('POST /channels/'))).toBe(false);
  });
});

describe('when the unban fails', () => {
  const stick = (h: ReturnType<typeof harness>): void => {
    h.rest.fail(
      (call) => call.method === 'DELETE' && call.path === `/guilds/${GUILD}/bans/${MEMBER}`,
      { status: 500, body: { message: 'Internal Server Error' } },
    );
  };

  test('retries once and leaves the outcome as ban_stuck, never as a softban', async () => {
    const h = harness();
    stick(h);

    const outcome = await h.trip({ config: { ...armed(), logChannelId: LOG } });

    expect(outcome).toEqual({ action: 'ban_stuck', userId: MEMBER });
    expect(h.calls().filter((call) => call === UNBAN)).toHaveLength(2);
  });

  test('says they are still banned, and names who and where', async () => {
    const h = harness();
    stick(h);

    await h.trip({ config: { ...armed(), logChannelId: LOG } });

    const stuck = h.said('error').find((message) => message.includes('still banned'));
    expect(stuck).toContain(MEMBER);
    expect(stuck).toContain(GUILD);
    expect(stuck).toContain('They are still banned and a moderator has to unban them by hand.');
  });

  test('posts the alarm colour to the log channel, never the ok green', async () => {
    const h = harness();
    stick(h);

    await h.trip({ config: { ...armed(), logChannelId: LOG } });

    const embed = h.embedIn(LOG);
    expect(embed?.color).toBe(HONEYPOT_COLOUR);
    expect(embed?.color).not.toBe(HONEYPOT_OK);
    expect(fieldsOf(embed).get('Result')).toBe('FAILED — the member is still banned');
  });

  test('tells the rest of Proton that the member is still banned', async () => {
    const h = harness();
    stick(h);

    await h.trip({ config: armed() });

    const published = h.published.at(-1);
    expect(published?.type).toBe('proton.security_tripped');
    expect(JSON.stringify(published?.payload)).toContain('the unban FAILED');
  });

  test('a retry that lands is a finished softban, not a refused one', async () => {
    const h = harness();

    let attempts = 0;
    h.rest.fail(
      (call) => {
        if (call.method !== 'DELETE' || call.path !== `/guilds/${GUILD}/bans/${MEMBER}`) {
          return false;
        }
        attempts += 1;
        return attempts === 1;
      },
      { status: 500, body: { message: 'Internal Server Error' } },
    );

    const outcome = await h.trip({ config: armed() });

    expect(outcome.action).toBe('sprung');
    expect(h.calls().filter((call) => call === UNBAN)).toHaveLength(2);
    expect(h.said('error').some((message) => message.includes('still banned'))).toBe(false);

    // The ban did land, so its own window took the message. Deleting it again here would mean the
    // module treats a recovered softban as a failed one.
    expect(h.deleted()).toEqual([]);
  });
});

describe('when Proton cannot act', () => {
  test('refuses without Ban Members, naming the permission and where it is missing', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.BanMembers });

    const outcome = await h.trip({ config: { ...armed(), logChannelId: LOG } });

    expect(refusal(outcome)).toContain('Ban Members');
    expect(refusal(outcome)).toContain('this server');
  });

  test('half-applies nothing without Ban Members — no ban, and so no lift to owe', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.BanMembers });

    await h.trip({ config: armed() });

    expect(h.calls().some((call) => call.includes('/bans/'))).toBe(false);
  });

  test('still deletes the message when the ban was refused — nothing purged it', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.BanMembers });

    await h.trip({ config: { ...armed(), logChannelId: LOG } });

    expect(h.deleted()).toEqual([`${TRAP}/${MESSAGE}`]);
    expect(h.embedIn(LOG)?.color).toBe(HONEYPOT_ALARM);
    expect(fieldsOf(h.embedIn(LOG)).get('Result')).toBe('Could not be carried out');
  });

  test('refuses on a member ranked above the bot, naming the fix', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), authorId: ABOVE });

    expect(refusal(outcome)).toContain('above or equal to mine');
    expect(refusal(outcome)).toContain('Server Settings → Roles');
    expect(h.calls().some((call) => call.includes('/bans/'))).toBe(false);
    expect(h.deleted()).toEqual([`${TRAP}/${MESSAGE}`]);
  });

  test('reports a member who left rather than retrying the ban', async () => {
    const h = harness();
    h.rest.fail((call) => call.method === 'PUT' && call.path.includes('/bans/'), {
      status: 404,
      body: { message: 'Unknown User' },
    });

    const outcome = await h.trip({ config: armed() });

    expect(refusal(outcome)).toContain('may have left');
    expect(h.calls().filter((call) => call === BAN)).toHaveLength(1);
    expect(h.deleted()).toEqual([`${TRAP}/${MESSAGE}`]);
  });
});
