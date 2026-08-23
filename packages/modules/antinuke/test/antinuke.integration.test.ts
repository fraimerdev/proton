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

function burstEvents(
  dispatches: readonly RawDispatch[] = dispatchSequence('auditLogChannelDeleteBurst'),
) {
  return dispatches.map((raw) => {
    const event = normalise(raw)[0];
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

    expect((last?.occurredAt ?? 0) - (first?.occurredAt ?? 0)).toBeLessThan(5_000);
  });

  test('trips the breaker, and strips roles before anything else', async () => {
    const events = burstEvents();
    const { h } = build(events[0]?.occurredAt ?? 0);

    const outcomes = await replay(h, events, { alertChannelId: ALERT_CHANNEL });

    const tripped = outcomes.filter((outcome) => outcome.action === 'tripped');

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

  test('replaying the same burst twice reaches the same verdict and acts once', async () => {
    const { h } = build(Date.now());

    await replay(h, burstEvents());
    const afterFirst = h.rest.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await replay(h, burstEvents());

    expect(second.filter((outcome) => outcome.action === 'tripped')).toHaveLength(1);

    expect(h.rest.calls).toHaveLength(afterFirst);
  });

  test('bans only after the roles are already off', async () => {
    const events = burstEvents();
    const { h } = build(events[0]?.occurredAt ?? 0);

    await replay(h, events, { afterStrip: 'ban', alertChannelId: ALERT_CHANNEL });

    expect(h.callPaths()).toEqual([
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_HIGH_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${NUKER}/roles/${NUKER_LOW_ROLE}`,
      `PUT /guilds/${GUILD}/bans/${NUKER}`,
      `POST /channels/${ALERT_CHANNEL}/messages`,
    ]);
  });

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

    expect(h.callPaths()).toEqual([`POST /channels/${ALERT_CHANNEL}/messages`]);
    expect(h.alertContent()).toContain('transfer ownership');
  });

  test('counts each actor separately, so two busy admins do not add up', async () => {
    const { h } = build(Date.now());
    const events = burstEvents();

    events.forEach((event, index) => {
      if (index % 2 === 1) {
        (event.payload as { actorId: string }).actorId = ADMIN;
      }
    });

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

    expect(await redis.keys('proton:rate:*')).toEqual([]);
  });

  test('re-arms once the window has expired, and says so once', async () => {
    const events = burstEvents();
    const start = events[0]?.occurredAt ?? 0;
    const { h, maintenance, clock } = build(start);

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
