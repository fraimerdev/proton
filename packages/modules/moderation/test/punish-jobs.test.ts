import { describe, expect, test } from 'bun:test';
import {
  createTimeoutJobHandler,
  EXPIRED_REASON,
  expiryRoot,
  MemberLookupUnavailableError,
  renewKey,
  runTimeoutCheck,
} from '../src/punish/jobs.ts';
import { APPLY_CAP_MS, clampUntil, RENEW_LEAD_MS, TIMEOUT_JOB } from '../src/punish/timeouts.ts';
import { baseGuildState, GUILD, MEMBER } from './harness.ts';
import { callsTo, FULL_BOT, type KitOptions, kit } from './punish-kit.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function namedKit(options: KitOptions = {}) {
  const state = baseGuildState(FULL_BOT);
  state.name = 'Proton HQ';
  return kit({ state, ...options });
}

type Kit = ReturnType<typeof kit>;

async function seed(
  k: Kit,
  input: { caseId: string; endsAt: number; appliedUntil: number | null; startedAt?: number },
): Promise<void> {
  await k.timeouts.record({
    caseId: input.caseId,
    guildId: GUILD,
    userId: MEMBER,
    startedAt: new Date(input.startedAt ?? k.h.now()),
    endsAt: new Date(input.endsAt),
    appliedUntil: input.appliedUntil === null ? null : new Date(input.appliedUntil),
  });
}

function timeoutPatches(k: Kit): number[] {
  return k.h.rest.calls
    .filter((call) => call.method === 'PATCH' && call.path === `/guilds/${GUILD}/members/${MEMBER}`)
    .map((call) =>
      Date.parse(
        (call.body as { communication_disabled_until: string }).communication_disabled_until,
      ),
    );
}

function timeoutJob(k: Kit) {
  return k.h.pendingJobs().find((call) => call.jobId === TIMEOUT_JOB && call.naturalKey === MEMBER);
}

async function runJob(k: Kit): Promise<void> {
  await createTimeoutJobHandler(k.deps)({ userId: MEMBER }, k.ctx());
}

describe('a timeout that runs out', () => {
  test('is closed as expired, logged once and the member is told once', async () => {
    const k = namedKit({ config: { punish: { notifications: { onUnpunish: true } } } });
    const start = k.h.now();
    await seed(k, { caseId: 'Case001', endsAt: start + HOUR, appliedUntil: start + HOUR });
    k.lookups.set(MEMBER, {
      state: 'member',
      roleIds: [],
      timeoutUntil: start + HOUR,
      joinedAt: null,
    });

    k.h.advance(HOUR);
    await runJob(k);
    await runJob(k);

    expect(k.timeouts.rows.get('Case001')).toMatchObject({
      closeReason: 'expired',
      closedAt: start + HOUR,
      expiryLoggedAt: start + HOUR,
    });

    expect(k.h.published).toEqual([
      {
        type: 'moderation.punishment_expired',
        naturalKey: 'Case001',
        payload: {
          guildId: GUILD,
          caseId: 'Case001',
          kind: 'timeout',
          userId: MEMBER,
          endedAt: start + HOUR,
          memberPresent: true,
        },
      },
    ]);

    const dms = k.h.dms();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.userId).toBe(MEMBER);
    expect(dms[0]?.message.embeds?.[0]?.title).toBe('Your timeout in Proton HQ has ended');
    expect(dms[0]?.message.embeds?.[0]?.description).toBe(EXPIRED_REASON);
    expect(k.h.keysUsed()).toContain(`${expiryRoot(GUILD, 'Case001')}:dm:send`);
    expect(k.h.requests.every((request) => request.record === false)).toBe(true);
    expect(timeoutPatches(k)).toEqual([]);
    expect(timeoutJob(k)).toBeUndefined();
  });

  test('a timeout someone removed early in Discord is logged, but nobody says it just ended', async () => {
    const k = namedKit({ config: { punish: { notifications: { onUnpunish: true } } } });
    const start = k.h.now();
    await seed(k, { caseId: 'Case009', endsAt: start + DAY, appliedUntil: start + DAY });
    k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: null, joinedAt: null });

    k.h.advance(DAY);
    await runJob(k);

    expect(k.h.published.map((event) => event.naturalKey)).toEqual(['Case009']);
    expect(k.h.dms()).toHaveLength(0);
    expect(k.timeouts.rows.get('Case009')?.closeReason).toBe('expired');
  });

  test('a member who left is logged as absent while the setting says to log it', async () => {
    const k = namedKit({ config: { punish: { notifications: { onUnpunish: true } } } });
    k.lookups.set(MEMBER, { state: 'absent' });
    await seed(k, { caseId: 'Case002', endsAt: k.h.now() + HOUR, appliedUntil: k.h.now() + HOUR });

    k.h.advance(HOUR);
    await runJob(k);

    expect(k.h.published).toHaveLength(1);
    expect(k.h.published[0]?.payload).toMatchObject({ caseId: 'Case002', memberPresent: false });
    expect(k.h.dms()).toHaveLength(0);
    expect(k.timeouts.rows.get('Case002')?.closeReason).toBe('expired');
  });

  test('with "log when absent" off, a member who left gets no expiry event', async () => {
    const k = namedKit({ config: { punish: { logExpiredWhenAbsent: false } } });
    k.lookups.set(MEMBER, { state: 'absent' });
    await seed(k, { caseId: 'Case003', endsAt: k.h.now() + HOUR, appliedUntil: k.h.now() + HOUR });

    k.h.advance(HOUR);
    await runJob(k);

    expect(k.h.published).toEqual([]);
    expect(k.timeouts.rows.get('Case003')?.closeReason).toBe('expired');
  });

  test('an earlier timeout ending while a later one stays is logged, but nobody is told', async () => {
    const k = namedKit({
      config: {
        punish: {
          types: { timeout: { allowMultiple: true } },
          notifications: { onUnpunish: true },
        },
      },
    });
    const start = k.h.now();
    await seed(k, { caseId: 'Short01', endsAt: start + HOUR, appliedUntil: start + 2 * HOUR });
    await seed(k, { caseId: 'Long001', endsAt: start + 2 * HOUR, appliedUntil: start + 2 * HOUR });

    k.h.advance(HOUR);
    await runJob(k);

    expect(k.h.published.map((event) => event.naturalKey)).toEqual(['Short01']);
    expect(k.h.dms()).toHaveLength(0);
    expect(k.timeouts.rows.get('Long001')?.closedAt).toBeNull();
    expect(timeoutJob(k)?.runAt.getTime()).toBe(start + 2 * HOUR);
  });

  test('a lookup Discord cannot answer is retried rather than logged as absent', async () => {
    const k = namedKit();
    k.lookups.set(MEMBER, { state: 'unavailable', status: 503 });
    await seed(k, { caseId: 'Case004', endsAt: k.h.now() + HOUR, appliedUntil: k.h.now() + HOUR });

    k.h.advance(HOUR);
    await expect(runJob(k)).rejects.toBeInstanceOf(MemberLookupUnavailableError);

    expect(k.h.published).toEqual([]);
    expect(k.timeouts.rows.get('Case004')?.closedAt).toBeNull();
  });
});

describe('extending a timeout past 28 days', () => {
  // The executor judges the 28-day cap by the real clock, so age the timeout, don't advance.
  function longTimeout() {
    const k = namedKit({ config: { punish: { extendTimeouts: true } } });
    const start = k.h.now() - (APPLY_CAP_MS - RENEW_LEAD_MS);
    const endsAt = start + 40 * DAY;
    const appliedUntil = start + APPLY_CAP_MS;
    return { k, start, endsAt, appliedUntil };
  }

  test('renews an hour before the applied end, with a per-minute key and no case', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long002', endsAt, appliedUntil });
    k.lookups.set(MEMBER, {
      state: 'member',
      roleIds: [],
      timeoutUntil: appliedUntil,
      joinedAt: null,
    });

    const now = k.h.now();
    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('renewed');

    const until = clampUntil(endsAt, now);
    expect(timeoutPatches(k)).toEqual([until]);

    const renewal = k.h.requests.find((request) => request.kind === 'timeout');
    expect(renewal).toMatchObject({
      idempotencyKey: renewKey(GUILD, MEMBER, now),
      record: false,
      targetId: MEMBER,
    });
    expect(renewal?.idempotencyKey).toBe(
      `moderation:timeout:${GUILD}:${MEMBER}:renew:${Math.floor(now / MINUTE)}`,
    );
    expect(k.h.cases()).toHaveLength(0);

    expect(k.timeouts.rows.get('Long002')?.appliedUntil).toBe(until);
    expect(timeoutJob(k)?.runAt.getTime()).toBe(endsAt);
    expect(timeoutJob(k)?.options).toEqual({ replace: true });
  });

  test('a longer timeout set by hand in Discord is left alone, and the renewal books its end', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long010', endsAt, appliedUntil });
    const manual = endsAt + 8 * DAY;
    k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: manual, joinedAt: null });

    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('already');

    expect(timeoutPatches(k)).toEqual([]);
    expect(k.timeouts.rows.get('Long010')?.appliedUntil).toBe(manual);
    expect(timeoutJob(k)?.runAt.getTime()).toBe(endsAt);
  });

  test('a timeout someone removed in Discord is closed, never reapplied', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long003', endsAt, appliedUntil });
    k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: null, joinedAt: null });

    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('removed_in_discord');

    expect(timeoutPatches(k)).toEqual([]);
    expect(k.timeouts.rows.get('Long003')?.closeReason).toBe('removed_in_discord');
    expect(timeoutJob(k)).toBeUndefined();
  });

  test('a timeout someone shortened in Discord counts as removed too', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long004', endsAt, appliedUntil });
    k.lookups.set(MEMBER, {
      state: 'member',
      roleIds: [],
      timeoutUntil: appliedUntil - 30 * MINUTE,
      joinedAt: null,
    });

    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('removed_in_discord');
    expect(timeoutPatches(k)).toEqual([]);
  });

  test('a member who left keeps their rows and is checked again in an hour', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long005', endsAt, appliedUntil });
    k.lookups.set(MEMBER, { state: 'absent' });

    const now = k.h.now();
    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('absent');

    expect(timeoutPatches(k)).toEqual([]);
    expect(k.timeouts.rows.get('Long005')?.closedAt).toBeNull();
    expect(timeoutJob(k)?.runAt.getTime()).toBe(now + HOUR);
  });

  test('a lookup Discord cannot answer throws so the job retries', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long006', endsAt, appliedUntil });
    k.lookups.set(MEMBER, { state: 'unavailable', status: 500 });

    await expect(runTimeoutCheck(k.ctx(), k.deps, MEMBER)).rejects.toBeInstanceOf(
      MemberLookupUnavailableError,
    );
    expect(timeoutPatches(k)).toEqual([]);
  });

  test('a renewal Discord refuses for good is retried in an hour, not in a loop', async () => {
    const { k, endsAt, appliedUntil } = longTimeout();
    await seed(k, { caseId: 'Long007', endsAt, appliedUntil });
    k.lookups.set(MEMBER, {
      state: 'member',
      roleIds: [],
      timeoutUntil: appliedUntil,
      joinedAt: null,
    });
    k.h.rest.respond(/^PATCH \/guilds\/\d+\/members\//, {
      status: 403,
      body: { code: 50013, message: 'Missing Permissions' },
    });

    const now = k.h.now();
    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('renew_failed');

    expect(k.timeouts.rows.get('Long007')?.appliedUntil).toBe(appliedUntil);
    expect(timeoutJob(k)?.runAt.getTime()).toBe(now + HOUR);
    expect(k.h.logs.some((log) => log.message.includes('could not keep'))).toBe(true);
  });

  test('a check that runs early only books the renewal point', async () => {
    const { k } = longTimeout();
    const start = k.h.now();
    const appliedUntil = start + APPLY_CAP_MS;
    await seed(k, { caseId: 'Long008', endsAt: start + 40 * DAY, appliedUntil });

    expect(await runTimeoutCheck(k.ctx(), k.deps, MEMBER)).toBe('waiting');

    expect(timeoutPatches(k)).toEqual([]);
    expect(timeoutJob(k)?.runAt.getTime()).toBe(appliedUntil - RENEW_LEAD_MS);
  });
});

describe('the timeout job itself', () => {
  test('does nothing while moderation is off', async () => {
    const k = namedKit({ config: { enabled: false } });
    await seed(k, { caseId: 'Case005', endsAt: k.h.now() + HOUR, appliedUntil: k.h.now() + HOUR });

    k.h.advance(HOUR);
    await runJob(k);

    expect(k.timeouts.rows.get('Case005')?.closedAt).toBeNull();
    expect(k.h.published).toEqual([]);
  });

  test('drops a job without a member id', async () => {
    const k = namedKit();

    await createTimeoutJobHandler(k.deps)({ nope: true }, k.ctx());

    expect(k.h.logs.some((log) => log.level === 'error')).toBe(true);
    expect(callsTo(k.h, /./)).toEqual([]);
  });

  test('refuses to guess without a timeout store', async () => {
    const k = namedKit();
    const { timeouts: _unbound, ...deps } = k.deps;

    expect(await runTimeoutCheck(k.ctx(), deps, MEMBER)).toBe('untracked');
    expect(k.h.logs.some((log) => log.message.includes('no timeout store'))).toBe(true);
  });
});
