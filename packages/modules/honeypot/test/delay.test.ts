import { describe, expect, test } from 'bun:test';
import { PUNISH_JOB } from '../src/punish.ts';
import { armed, GUILD, harness, LOW_ROLE, MEMBER, MESSAGE, TRAP } from './harness.ts';

const WAITS = armed({ waitBeforeActingSeconds: 3600 });

describe('a server that waits before acting', () => {
  test('books the punishment and does nothing to the member yet', async () => {
    const h = harness();

    const outcome = await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });

    expect(outcome.action).toBe('waiting');
    expect(h.requests().map((request) => request.kind)).toEqual([]);
    expect(h.booked).toHaveLength(1);
  });

  test('books it for exactly the configured wait', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });

    expect(h.booked[0]?.runAt).toBe(h.now() + 3600 * 1000);
  });

  // Keyed on the member, not the message: the burst lock lets go after a minute and the wait can
  // be a week, so a bot posting every couple of minutes would otherwise park one job per message.
  test('is keyed on the member, so a second catch does not book a second punishment', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });
    h.advance(120_000);
    await h.trip({ config: WAITS, roleIds: [LOW_ROLE], messageId: '1400000000000000002' });

    expect(h.booked).toHaveLength(1);
    expect(h.booked[0]?.naturalKey).toBe(MEMBER);
  });

  test('and the second catch does not push the first punishment further out', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });
    const first = h.booked[0]?.runAt;

    h.advance(120_000);
    await h.trip({ config: WAITS, roleIds: [LOW_ROLE], messageId: '1400000000000000002' });

    expect(h.booked[0]?.runAt).toBe(first as number);
  });

  test('acts immediately when the wait is zero, booking nothing', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), roleIds: [LOW_ROLE] });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.booked).toEqual([]);
  });
});

describe('the punishment coming due', () => {
  test('does what an immediate catch would have done', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });
    await h.runDue(PUNISH_JOB, MEMBER, WAITS);

    expect(h.requests().map((request) => request.kind)).toEqual(['ban', 'unban']);
  });

  // The punishment is frozen at catch time. A guild that changes its mind during the wait has not
  // changed its mind about a member it already caught under the old settings.
  test('runs under the settings it was booked with, not the ones saved since', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });
    await h.runDue(PUNISH_JOB, MEMBER, { ...WAITS, action: 'kick' });

    expect(h.requests().map((request) => request.kind)).toEqual(['ban', 'unban']);
  });

  test('counts the catch and logs it, exactly as an immediate one does', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });
    await h.runDue(PUNISH_JOB, MEMBER, WAITS);

    expect(h.stats.caught(GUILD, TRAP).map((entry) => entry.messageId)).toEqual([MESSAGE]);
  });
});

// Without this a softban booked minutes ago fires its unban leg and lifts the ban the moderator
// placed themselves.
describe('a member dealt with while the punishment waits', () => {
  test('has the pending punishment called off', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });
    await h.left(MEMBER, WAITS);

    expect(h.cancelled).toEqual([{ jobId: PUNISH_JOB, naturalKey: MEMBER }]);
    expect(h.booked).toEqual([]);
  });

  test('is remembered, so a sweep already holding the row still stops', async () => {
    const h = harness();

    await h.trip({ config: WAITS, roleIds: [LOW_ROLE] });

    const job = h.booked[0];
    await h.left(MEMBER, WAITS);

    // The row was already claimed, so it runs anyway. The tombstone is what stops it there.
    h.booked.push(job as (typeof h.booked)[number]);
    await h.runDue(PUNISH_JOB, MEMBER, WAITS);

    expect(h.requests().map((request) => request.kind)).toEqual([]);
  });

  test('is ignored entirely in a server that does not wait', async () => {
    const h = harness();

    const outcome = await h.left(MEMBER, armed());

    expect(outcome).toEqual({
      action: 'ignored',
      reason: 'this server does not wait before acting',
    });
    expect(h.cancelled).toEqual([]);
  });
});
