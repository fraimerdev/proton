import { describe, expect, test } from 'bun:test';
import {
  APPLY_CAP_MS,
  clampUntil,
  effectiveEnd,
  nextRunAt,
  RENEW_LEAD_MS,
  TIMEOUT_JOB,
} from '../src/punish/timeouts.ts';
import { MEMBER } from './harness.ts';
import { executed, kit, request } from './punish-kit.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function heldByDiscord(k: ReturnType<typeof kit>, until: number | null): void {
  k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: until, joinedAt: null });
}

function appliedUntil(k: ReturnType<typeof kit>): number[] {
  return k.h.rest.calls
    .filter((call) => call.method === 'PATCH' && call.path.includes('/members/'))
    .map((call) =>
      Date.parse(
        (call.body as { communication_disabled_until: string }).communication_disabled_until,
      ),
    );
}

describe('the timeout arithmetic', () => {
  test('the effective end is the latest end among the open timeouts', () => {
    expect(effectiveEnd([{ endsAt: 5 }, { endsAt: 9 }, { endsAt: 7 }])).toBe(9);
    expect(effectiveEnd([], 4)).toBe(4);
    expect(effectiveEnd([])).toBeNull();
  });

  test('Discord is never asked for more than 28 days less a safety margin', () => {
    expect(clampUntil(40 * DAY, 0)).toBe(APPLY_CAP_MS);
    expect(clampUntil(HOUR, 0)).toBe(HOUR);
  });

  test('the next run is the first end, or an hour before the applied cap when renewal is due', () => {
    const now = 1_000;
    expect(
      nextRunAt([{ endsAt: now + HOUR }, { endsAt: now + 2 * HOUR }], now + 2 * HOUR, now),
    ).toBe(now + HOUR);
    expect(nextRunAt([{ endsAt: now + 40 * DAY }], now + APPLY_CAP_MS, now)).toBe(
      now + APPLY_CAP_MS - RENEW_LEAD_MS,
    );
    expect(nextRunAt([], null, now)).toBeNull();
  });
});

describe('multiple timeouts', () => {
  test('by default a new timeout supersedes the open ones and Discord gets its own end', async () => {
    const k = kit();
    const now = k.h.now();

    const first = executed(await k.run(request('timeout', { duration: '2h' })));
    heldByDiscord(k, now + 2 * HOUR);
    const second = executed(
      await k.run(request('timeout', { duration: '30m', idempotencyRoot: 'evt-2' })),
    );

    const rows = [...k.timeouts.rows.values()];
    expect(rows.map((row) => [row.caseId, row.closeReason])).toEqual([
      [first.caseId, 'superseded'],
      [second.caseId, null],
    ]);
    expect(appliedUntil(k)).toEqual([now + 2 * HOUR, now + 30 * MINUTE]);
    expect(k.timeouts.rows.get(second.caseId ?? '')?.appliedUntil).toBe(now + 30 * MINUTE);

    const job = k.h.pendingJobs().find((call) => call.jobId === TIMEOUT_JOB);
    expect(job).toMatchObject({ naturalKey: MEMBER, data: { userId: MEMBER } });
    expect(job?.runAt.getTime()).toBe(now + 30 * MINUTE);
    expect(job?.options).toEqual({ replace: true });
  });

  test('with multiple timeouts allowed, all stay open and Discord gets the latest end', async () => {
    const k = kit({ config: { punish: { types: { timeout: { allowMultiple: true } } } } });
    const now = k.h.now();

    await k.run(request('timeout', { duration: '2h' }));
    heldByDiscord(k, now + 2 * HOUR);
    const second = executed(
      await k.run(request('timeout', { duration: '30m', idempotencyRoot: 'evt-2' })),
    );

    expect([...k.timeouts.rows.values()].every((row) => row.closedAt === null)).toBe(true);
    expect(appliedUntil(k)).toEqual([now + 2 * HOUR, now + 2 * HOUR]);
    expect(second.summary).toContain('because of an earlier timeout');
    expect(second.expiresAt).toBe(now + 30 * MINUTE);

    const job = k.h.pendingJobs().find((call) => call.jobId === TIMEOUT_JOB);
    expect(job?.runAt.getTime()).toBe(now + 30 * MINUTE);
  });

  test('a Proton timeout someone removed by hand is never brought back by a new one', async () => {
    const k = kit({ config: { punish: { types: { timeout: { allowMultiple: true } } } } });
    const now = k.h.now();

    const first = executed(await k.run(request('timeout', { duration: '7d' })));
    heldByDiscord(k, null);
    const second = executed(
      await k.run(request('timeout', { duration: '10m', idempotencyRoot: 'evt-2' })),
    );

    expect(appliedUntil(k)).toEqual([now + 7 * DAY, now + 10 * MINUTE]);
    expect(k.timeouts.rows.get(first.caseId ?? '')?.closeReason).toBe('removed_in_discord');
    expect(second.summary).not.toContain('because of an earlier timeout');
  });

  test('with multiple timeouts allowed, a longer one Discord already holds is kept', async () => {
    const k = kit({ config: { punish: { types: { timeout: { allowMultiple: true } } } } });
    const now = k.h.now();
    heldByDiscord(k, now + DAY);

    const outcome = executed(await k.run(request('timeout', { duration: '1h' })));

    expect(appliedUntil(k)).toEqual([now + DAY]);
    expect(outcome.summary).toContain('because of an earlier timeout');
  });

  test('by default a new timeout replaces whatever Discord holds', async () => {
    const k = kit();
    const now = k.h.now();
    heldByDiscord(k, now + DAY);

    await k.run(request('timeout', { duration: '1h' }));

    expect(appliedUntil(k)).toEqual([now + HOUR]);
  });
});

describe('extend timeouts', () => {
  test('past 28 days is refused unless Extend timeouts is on, and says where to turn it on', async () => {
    const k = kit();

    const outcome = await k.run(request('timeout', { duration: '40d' }));

    expect(outcome).toEqual({
      status: 'refused',
      code: 'duration_too_long',
      message: expect.stringContaining('Extend timeouts'),
    });
    expect(k.h.requests).toHaveLength(0);
  });

  test('past a year is refused even with Extend timeouts on', async () => {
    const k = kit({ config: { punish: { extendTimeouts: true } } });

    expect(await k.run(request('timeout', { duration: '400d' }))).toMatchObject({
      status: 'refused',
      code: 'duration_too_long',
    });
  });

  test('a zero or unreadable duration is refused', async () => {
    const k = kit();

    expect(await k.run(request('timeout', { duration: '0m' }))).toMatchObject({
      code: 'invalid_duration',
    });
    expect(await k.run(request('timeout', { duration: 'soon' }))).toMatchObject({
      code: 'invalid_duration',
    });
  });

  test('with Extend timeouts on, 40 days applies 28 days now and books the renewal', async () => {
    const k = kit({ config: { punish: { extendTimeouts: true } } });
    const now = k.h.now();

    const outcome = executed(await k.run(request('timeout', { duration: '40d' })));

    expect(appliedUntil(k)).toEqual([now + APPLY_CAP_MS]);
    const row = k.timeouts.rows.get(outcome.caseId ?? '');
    expect(row).toMatchObject({ endsAt: now + 40 * DAY, appliedUntil: now + APPLY_CAP_MS });
    expect(outcome.summary).toContain('it will be renewed until');

    const job = k.h.pendingJobs().find((call) => call.jobId === TIMEOUT_JOB);
    expect(job?.runAt.getTime()).toBe(now + APPLY_CAP_MS - RENEW_LEAD_MS);
  });

  test('the case keeps the end Proton renews to, not the 28 days Discord is given', async () => {
    const k = kit({ config: { punish: { extendTimeouts: true } } });
    const now = k.h.now();

    executed(await k.run(request('timeout', { duration: '60d' })));

    expect(k.h.cases().find((c) => c.kind === 'timeout')?.payload).toEqual({
      userId: MEMBER,
      until: new Date(now + APPLY_CAP_MS),
      endsAt: new Date(now + 60 * DAY),
    });
  });

  test('the default timeout length is used when the moderator gives none', async () => {
    const k = kit({ config: { punish: { types: { timeout: { defaultDuration: '15m' } } } } });
    const now = k.h.now();

    executed(await k.run(request('timeout')));

    expect(appliedUntil(k)).toEqual([now + 15 * MINUTE]);
  });
});
