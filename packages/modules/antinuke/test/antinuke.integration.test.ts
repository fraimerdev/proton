import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisRateWindow } from '@proton/core';
import { dispatchSequence, type RawDispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { AntinukeOutcome } from '../src/listeners.ts';
import {
  MAINTENANCE_GRACE_MS,
  type MaintenanceWindow,
  maintenanceKey,
  RedisMaintenanceStore,
} from '../src/maintenance.ts';
import {
  ADMIN,
  ALERT_CHANNEL,
  GUILD,
  type Harness,
  harness,
  NUKER,
  NUKER_HIGH_ROLE,
  NUKER_LOW_ROLE,
  OWNER,
} from './harness.ts';

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

/**
 * PLAN.md §12's literal Gate 2 input, replayed through the real normaliser.
 *
 * Not hand-built events: the fixture is a recorded gateway burst and the
 * normaliser is the production adapter, so if either changes shape this suite
 * fails rather than testing a shape nothing sends.
 */
function burstEvents(
  dispatches: readonly RawDispatch[] = dispatchSequence('auditLogChannelDeleteBurst'),
) {
  return dispatches.map((raw) => {
    const event = normalise(raw);
    if (!event) throw new Error(`the normaliser produced nothing for ${raw.t}`);
    return event;
  });
}

interface Built {
  h: Harness;
  clock: { now: number };
  maintenance: RedisMaintenanceStore;
}

function build(now: number): Built {
  const clock = { now };
  const maintenance = new RedisMaintenanceStore(redis, { now: () => clock.now });
  const h = harness({ clock, maintenance, rateWindow: new RedisRateWindow(redis) });
  return { h, clock, maintenance };
}

async function replay(
  h: Harness,
  events: ReturnType<typeof burstEvents>,
  config: Parameters<Harness['handle']>[1] = {},
): Promise<AntinukeOutcome[]> {
  const outcomes: AntinukeOutcome[] = [];
  for (const event of events) outcomes.push(await h.handle(event, config));
  return outcomes;
}

describe('Gate 2: 20 channel deletions in 5 seconds', () => {
  test('the fixture really is a five-second burst by one actor', () => {
    const events = burstEvents();
    const first = events[0];
    const last = events[events.length - 1];

    expect(events).toHaveLength(20);
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(['channel.deleted']));
    // The span lives in the entry snowflakes, so no test can widen it by editing
    // a timestamp field.
    expect((last?.occurredAt ?? 0) - (first?.occurredAt ?? 0)).toBeLessThan(5_000);
  });

  test('trips the breaker, and strips roles before anything else', async () => {
    const events = burstEvents();
    const { h } = build(events[0]?.occurredAt ?? 0);

    const outcomes = await replay(h, events, { alertChannelId: ALERT_CHANNEL });

    const tripped = outcomes.filter((outcome) => outcome.action === 'tripped');
    // Once, on the crossing — not on all eighteen occurrences above the limit.
    expect(tripped).toHaveLength(1);
    expect(outcomes.indexOf(tripped[0] as AntinukeOutcome)).toBe(2);

    expect(h.callPaths()).toEqual([
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
      `POST /channels/${ALERT_CHANNEL}/messages`,
    ]);
    expect(h.alertContent()).toContain('3 channel deletions within 30s');
  });

  test('trips on the same occurrence when the entries arrive out of order', async () => {
    // Audit-log delivery is unordered (§15), so detection may not depend on
    // sequence. Reversed is the worst case a fixture can express: the newest
    // entry first, the oldest last.
    const { h } = build(Date.now());
    const outcomes = await replay(h, burstEvents().reverse());

    const tripped = outcomes.filter((outcome) => outcome.action === 'tripped');
    expect(tripped).toHaveLength(1);
    expect(outcomes.indexOf(tripped[0] as AntinukeOutcome)).toBe(2);
    expect(h.callPaths()).toEqual([
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
    ]);
  });

  /**
   * RESUME is not a second attack.
   *
   * The guarantee is about *effects*, not about the verdict: replaying the burst
   * reaches the same conclusion again — deliberately, so that a breaker whose
   * first attempt died part-way through still fires when the bus redelivers —
   * but every action carries an idempotency key derived from the audit event, so
   * the executor discards them all and Discord sees nothing new (I4).
   */
  test('replaying the same burst twice reaches the same verdict and acts once', async () => {
    const { h } = build(Date.now());

    await replay(h, burstEvents());
    const afterFirst = h.rest.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await replay(h, burstEvents());

    expect(second.filter((outcome) => outcome.action === 'tripped')).toHaveLength(1);
    // Not one further call to Discord.
    expect(h.rest.calls).toHaveLength(afterFirst);
  });

  /**
   * The strongest reading of Gate 2's "breaker action is role-strip-first".
   *
   * The test above proves roles come off; this proves they come off *before* the
   * irreversible action, on the real fixture, with the ban actually performed.
   * `NODE_ENV=production` is set because I12 withholds destructive actions
   * everywhere else — without it the ban is planned and recorded but never
   * reaches Discord, and the ordering the criterion is about would not appear in
   * the call list at all.
   *
   * Ordering is the entire design: the strip is instant and exactly reversible,
   * so it is what stands between the attacker and the next deletion. A ban issued
   * first would be a slower call that leaves the roles on while it is in flight.
   */
  test('bans only after the roles are already off', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const events = burstEvents();
      const { h } = build(events[0]?.occurredAt ?? 0);

      await replay(h, events, { afterStrip: 'ban', alertChannelId: ALERT_CHANNEL });

      expect(h.callPaths()).toEqual([
        // Highest role first, so a rate limit partway through has already taken
        // the dangerous permissions away.
        `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
        `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
        `PUT /guilds/${GUILD}/bans/${NUKER}`,
        `POST /channels/${ALERT_CHANNEL}/messages`,
      ]);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  /**
   * §15: you cannot stop the guild owner, so do not pretend to. The breaker says
   * so once, in a sentence naming the remedy, rather than issuing a dozen calls
   * Discord refuses one at a time.
   */
  test('says so and does nothing when the actor owns the server', async () => {
    const events = burstEvents();
    for (const event of events) (event.payload as { actorId: string }).actorId = OWNER;
    const { h } = build(events[0]?.occurredAt ?? 0);

    const outcomes = await replay(h, events, { alertChannelId: ALERT_CHANNEL });

    const tripped = outcomes.find((outcome) => outcome.action === 'tripped');
    expect(tripped).toBeDefined();
    expect((tripped as Extract<AntinukeOutcome, { action: 'tripped' }>).report.ownerExempt).toBe(
      true,
    );
    // The alert is the only call: no role removals were even attempted.
    expect(h.callPaths()).toEqual([`POST /channels/${ALERT_CHANNEL}/messages`]);
    expect(h.alertContent()).toContain('transfer ownership');
  });

  test('counts each actor separately, so two busy admins do not add up', async () => {
    const { h } = build(Date.now());
    const events = burstEvents();

    // Same twenty deletions, split between two people.
    events.forEach((event, index) => {
      if (index % 2 === 1) {
        (event.payload as { actorId: string }).actorId = ADMIN;
      }
    });

    // Eleven would trip on twenty by one actor; ten each trips on neither.
    const outcomes = await replay(h, events, { channelDeleteLimit: 11 });

    expect(outcomes.some((outcome) => outcome.action === 'tripped')).toBe(false);
    expect(h.rest.calls).toEqual([]);
  });
});

describe('maintenance mode against real Redis', () => {
  test('suppresses the whole burst, and counts none of it', async () => {
    const events = burstEvents();
    const start = events[0]?.occurredAt ?? 0;
    const { h, maintenance } = build(start);

    await maintenance.set({
      guildId: GUILD,
      enabledBy: ADMIN,
      reason: 'moving twenty channels',
      startedAt: start - 60_000,
      expiresAt: start + 60_000,
    });

    const outcomes = await replay(h, events, { alertChannelId: ALERT_CHANNEL });

    expect(outcomes.every((outcome) => outcome.action === 'suppressed')).toBe(true);
    expect(h.rest.calls).toEqual([]);
    // Nothing was counted, so the window is not left loaded for the moment
    // maintenance ends.
    expect(await redis.keys('proton:rate:*')).toEqual([]);
  });

  test('re-arms once the window has expired, and says so once', async () => {
    const events = burstEvents();
    const start = events[0]?.occurredAt ?? 0;
    const { h, maintenance, clock } = build(start);

    // A window that closed a minute before this burst began.
    await maintenance.set({
      guildId: GUILD,
      enabledBy: ADMIN,
      reason: 'finished ten minutes ago',
      startedAt: start - 600_000,
      expiresAt: start - 60_000,
    });
    clock.now = start;

    const outcomes = await replay(h, events, { alertChannelId: ALERT_CHANNEL });

    expect(outcomes.filter((outcome) => outcome.action === 'tripped')).toHaveLength(1);
    const messages = h.discordCalls().filter((call) => call.path.endsWith('/messages'));
    // One lapse notice and one breaker report — not one notice per entry.
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0]?.body)).toContain('armed again');
  });
});

describe('RedisMaintenanceStore', () => {
  const window: MaintenanceWindow = {
    guildId: GUILD,
    enabledBy: ADMIN,
    reason: 'restructure',
    startedAt: 1_770_000_000_000,
    expiresAt: 1_770_000_600_000,
  };

  test('round-trips a window and lets Redis close the hole itself', async () => {
    const store = new RedisMaintenanceStore(redis, { now: () => window.startedAt });

    await store.set(window);

    expect(await store.get(GUILD)).toEqual(window);
    const ttl = await redis.pttl(maintenanceKey(GUILD));
    // The record outlives the window by the grace period, so audit entries that
    // arrive late are still recognised as covered.
    expect(ttl).toBeGreaterThan(600_000);
    expect(ttl).toBeLessThanOrEqual(600_000 + MAINTENANCE_GRACE_MS);
  });

  test('refuses to store a window that has already expired', async () => {
    const store = new RedisMaintenanceStore(redis, {
      now: () => window.expiresAt + MAINTENANCE_GRACE_MS + 1,
    });

    await store.set(window);

    expect(await store.get(GUILD)).toBeNull();
  });

  test('treats an unreadable record as no window, leaving the breaker armed', async () => {
    await redis.set(maintenanceKey(GUILD), 'not json at all');
    const store = new RedisMaintenanceStore(redis);

    expect(await store.get(GUILD)).toBeNull();
  });

  test('treats a record of the wrong shape as no window', async () => {
    await redis.set(maintenanceKey(GUILD), JSON.stringify({ guildId: GUILD, expiresAt: 'soon' }));
    const store = new RedisMaintenanceStore(redis);

    expect(await store.get(GUILD)).toBeNull();
  });

  test('clears on request', async () => {
    const store = new RedisMaintenanceStore(redis, { now: () => window.startedAt });
    await store.set(window);

    await store.clear(GUILD);

    expect(await store.get(GUILD)).toBeNull();
  });
});
