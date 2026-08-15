import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { ActionExecutor, ActionRequest, ActionResult } from '../../src/actions/types.ts';
import type { ProtonEvent } from '../../src/events/types.ts';
import { RuleEngine } from '../../src/rules/engine.ts';
import { RATE_WINDOW_PREFIX, RedisRateWindow, rateWindowKey } from '../../src/rules/rate-window.ts';
import type { GuildRule } from '../../src/rules/types.ts';

let container: StartedRedisContainer;
let redis: Redis;
let rateWindow: RedisRateWindow;
/** Separate sockets, so concurrent hits genuinely race rather than queueing. */
let clients: Redis[] = [];
let windows: RedisRateWindow[] = [];

const GUILD = '900000000000000001';
const MEMBER = '400000000000000000';
const RULE = 'automod:spam';
const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const CONNECTIONS = 8;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  rateWindow = new RedisRateWindow(redis);

  clients = Array.from({ length: CONNECTIONS }, () => new Redis(container.getConnectionUrl()));
  windows = clients.map((client) => new RedisRateWindow(client));
}, 240_000);

afterAll(async () => {
  for (const client of clients) client.disconnect();
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

function hit(overrides: Partial<Parameters<RedisRateWindow['hit']>[0]> = {}) {
  return rateWindow.hit({
    guildId: GUILD,
    ruleId: RULE,
    actorId: MEMBER,
    windowMs: 10_000,
    limit: 5,
    member: `event-${Math.random()}`,
    now: NOW,
    ...overrides,
  });
}

describe('RedisRateWindow', () => {
  test('counts occurrences inside the window and trips on the crossing', async () => {
    const counts: number[] = [];
    const trips: boolean[] = [];

    for (let i = 0; i < 8; i++) {
      const result = await hit({ member: `m${i}`, now: NOW + i });
      counts.push(result.count);
      trips.push(result.tripped);
    }

    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Exactly the fifth: a rule that stayed tripped would ban the same member
    // once per message for the rest of the burst.
    expect(trips).toEqual([false, false, false, false, true, false, false, false]);
  });

  /**
   * The reason PLAN.md §4-P2 insists the counter is atomic. Read-then-increment
   * from N workers consuming the same stream lets each of them observe a count
   * below the limit, and the burst the condition exists to catch walks straight
   * through.
   */
  test('N concurrent hits count exactly N, and the threshold trips exactly once', async () => {
    const total = 40;
    const limit = 10;

    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        // Round-robin across connections so the commands actually interleave.
        (windows[i % CONNECTIONS] as RedisRateWindow).hit({
          guildId: GUILD,
          ruleId: RULE,
          actorId: MEMBER,
          windowMs: 10_000,
          limit,
          member: `burst-${i}`,
          now: NOW,
        }),
      ),
    );

    // Every hit saw a distinct count: nothing was lost and nothing double-counted.
    expect([...results.map((r) => r.count)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    expect(results.filter((r) => r.tripped)).toHaveLength(1);
    expect(results.find((r) => r.tripped)?.count).toBe(limit);
    expect(await redis.zcard(rateWindowKey(GUILD, RULE, MEMBER))).toBe(total);
  });

  /**
   * The bus is at-least-once and RESUME redelivers, so the same event arrives
   * twice as a matter of course (I4). Counting it twice would let a quiet member
   * trip an anti-spam window they never crossed.
   */
  test('a redelivered occurrence is not counted twice', async () => {
    for (let i = 0; i < 4; i++) await hit({ member: `m${i}`, now: NOW + i });
    await hit({ member: 'm4', now: NOW + 4 });

    expect((await hit({ member: 'm4', now: NOW + 9 })).count).toBe(5);
  });

  /**
   * The redelivered *crossing* still reports the crossing.
   *
   * This assertion used to be `tripped: false`, on the reasoning that a second
   * trip would act twice. It does not — every caller derives its executor
   * idempotency key from the same event id, so the replayed action is discarded
   * as a duplicate (I4). What the old behaviour actually did was lose the
   * crossing altogether: `tripped` was an edge consumed by the first call, so if
   * anything downstream of the hit threw — a REST failure part-way through a
   * role strip, a blip reading guild state — the bus redelivered, the second
   * call saw the member already in the set, and reported a plain count. And
   * since `count == limit` holds only once per fill, nothing later in the same
   * attack tripped either. One transient error permanently disarmed the
   * anti-nuke breaker for that burst, in silence.
   *
   * So the crossing is answered idempotently instead: same occurrence, same
   * verdict, every time it is replayed.
   */
  test('replaying the occurrence that crossed reports the crossing again', async () => {
    for (let i = 0; i < 4; i++) await hit({ member: `m${i}`, now: NOW + i });

    expect(await hit({ member: 'm4', now: NOW + 4 })).toEqual({ count: 5, tripped: true });
    expect(await hit({ member: 'm4', now: NOW + 9 })).toEqual({ count: 5, tripped: true });
    expect(await hit({ member: 'm4', now: NOW + 20 })).toEqual({ count: 5, tripped: true });
  });

  /** Only the occurrence that crossed replays as a crossing — not its neighbours. */
  test('a different occurrence in the same full window does not report a crossing', async () => {
    for (let i = 0; i < 4; i++) await hit({ member: `m${i}`, now: NOW + i });
    await hit({ member: 'm4', now: NOW + 4 });

    // An earlier occurrence, redelivered after the window was already crossed.
    expect(await hit({ member: 'm2', now: NOW + 10 })).toEqual({ count: 5, tripped: false });
    // And a genuinely new one, which takes the count past the limit.
    expect(await hit({ member: 'm5', now: NOW + 11 })).toEqual({ count: 6, tripped: false });
  });

  test('occurrences slide out of the window, and the window re-arms', async () => {
    for (let i = 0; i < 5; i++) await hit({ member: `m${i}`, now: NOW + i });

    // 11s later the first five are outside a 10s window; only this one is left.
    const later = await hit({ member: 'later', now: NOW + 11_000 });
    expect(later).toEqual({ count: 1, tripped: false });

    const refilled = [];
    for (let i = 1; i <= 4; i++) {
      refilled.push(await hit({ member: `after-${i}`, now: NOW + 11_000 + i }));
    }

    expect(refilled.map((r) => r.count)).toEqual([2, 3, 4, 5]);
    // The window re-armed: a sustained flood keeps being caught rather than
    // tripping once and being ignored for the rest of the raid.
    expect(refilled.map((r) => r.tripped)).toEqual([false, false, false, true]);

    expect(await hit({ member: 'after-5', now: NOW + 11_005 })).toEqual({
      count: 6,
      tripped: false,
    });
  });

  test('windows are separate per guild, per rule and per actor', async () => {
    await hit({ member: 'a' });
    await hit({ member: 'b' });

    expect((await hit({ member: 'c', actorId: '400000000000000009' })).count).toBe(1);
    expect((await hit({ member: 'c', ruleId: 'automod:mentions' })).count).toBe(1);
    expect((await hit({ member: 'c', guildId: '900000000000000009' })).count).toBe(1);
    expect((await hit({ member: 'd' })).count).toBe(3);
  });

  test('the key follows the (guild, rule, actor) shape from the plan', async () => {
    await hit({ member: 'a' });

    const key = rateWindowKey(GUILD, RULE, MEMBER);
    expect(key).toBe(`${RATE_WINDOW_PREFIX}:${GUILD}:${RULE}:${MEMBER}`);
    expect(await redis.exists(key)).toBe(1);
  });

  test('the window expires on its own so idle members leave nothing behind', async () => {
    await hit({ member: 'a', windowMs: 30_000 });

    const ttl = await redis.pttl(rateWindowKey(GUILD, RULE, MEMBER));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });
});

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return { status: 'executed', caseId: 'case-1' };
  }
}

describe('RuleEngine with the real rate window', () => {
  test('a concurrent burst produces exactly one action, not one per message', async () => {
    const executor = new RecordingExecutor();
    const engine = new RuleEngine({ executor, rateWindow, now: () => NOW });

    const rule: GuildRule = {
      id: 'spam',
      guildId: GUILD,
      moduleId: 'automod',
      trigger: { kind: 'event', event: 'message.created' },
      conditions: [{ kind: 'rate-over-window', limit: 5, window: '10s' }],
      actions: [{ kind: 'timeout', duration: '10m', reason: 'Spamming' }],
      enabled: true,
      priority: 0,
    };

    const burst = Array.from({ length: 25 }, (_, i) => {
      const event: ProtonEvent = {
        id: `message.created:${i}`,
        type: 'message.created',
        guildId: GUILD,
        occurredAt: NOW,
        payload: {},
      };
      return engine.evaluate({ event, rules: [rule], facts: { actorId: MEMBER }, dryRun: false });
    });

    const reports = await Promise.all(burst);

    expect(reports.filter((r) => r.outcomes[0]?.fired)).toHaveLength(1);
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.targetId).toBe(MEMBER);
  });
});
