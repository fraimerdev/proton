import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { dlqKey, RedisStreamsEventBus } from '../../src/events/redis-streams.ts';
import type { EventType, ProtonEvent } from '../../src/events/types.ts';
import { newId } from '../../src/ids.ts';

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await redis.flushall();
});

function event(type: EventType = 'message.created', payload: unknown = {}): ProtonEvent {
  return { id: newId(), type, guildId: '900000000000000001', occurredAt: Date.now(), payload };
}

/** Poll until `predicate` holds or the budget expires — avoids arbitrary sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('waitFor timed out');
}

describe('RedisStreamsEventBus', () => {
  test('delivers a published event to a subscriber', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100 });
    const seen: ProtonEvent[] = [];

    const sub = bus.subscribe('g1', ['message.created'], async (e) => {
      seen.push(e);
    });

    const sent = event();
    await bus.publish(sent);

    await waitFor(() => seen.length === 1);
    expect(seen[0]?.id).toBe(sent.id);
    await sub.close();
  });

  test('delivers only the event types a subscriber asked for', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100 });
    const seen: ProtonEvent[] = [];

    const sub = bus.subscribe('g1', ['member.joined'], async (e) => {
      seen.push(e);
    });

    await bus.publish(event('message.created'));
    await bus.publish(event('member.joined'));

    await waitFor(() => seen.length === 1);
    // Give the unwanted type a chance to wrongly arrive before asserting.
    await Bun.sleep(200);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('member.joined');
    await sub.close();
  });

  test('splits work across consumers in one group, but fans out across groups', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100 });
    const groupA: ProtonEvent[] = [];
    const groupB: ProtonEvent[] = [];

    // Two consumers, same group — each event should go to exactly one of them.
    const a1 = bus.subscribe('shared', ['message.created'], async (e) => {
      groupA.push(e);
    });
    const a2 = bus.subscribe('shared', ['message.created'], async (e) => {
      groupA.push(e);
    });
    // A different group sees everything independently.
    const b1 = bus.subscribe('other', ['message.created'], async (e) => {
      groupB.push(e);
    });

    const count = 6;
    for (let i = 0; i < count; i++) await bus.publish(event());

    await waitFor(() => groupA.length >= count && groupB.length >= count);
    await Bun.sleep(200);

    expect(groupA).toHaveLength(count);
    expect(groupB).toHaveLength(count);

    await Promise.all([a1.close(), a2.close(), b1.close()]);
  });

  test('redelivers an event whose handler threw', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100, claimIdleMs: 100 });
    let attempts = 0;

    const sub = bus.subscribe('retry', ['message.created'], async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
    });

    await bus.publish(event());

    // First delivery throws and is left unacked; the reclaim path must pick it up.
    await waitFor(() => attempts >= 2, 10_000);
    expect(attempts).toBeGreaterThanOrEqual(2);

    await sub.close();
  });

  test('dead-letters an event that fails more than maxDeliveries times', async () => {
    const deadLettered: ProtonEvent[] = [];
    const bus = new RedisStreamsEventBus(redis, {
      blockMs: 50,
      claimIdleMs: 50,
      maxDeliveries: 2,
      onDeadLetter: (e) => deadLettered.push(e),
    });

    const sub = bus.subscribe('poison', ['message.created'], async () => {
      throw new Error('always fails');
    });

    const sent = event();
    await bus.publish(sent);

    await waitFor(() => deadLettered.length === 1, 15_000);
    expect(deadLettered[0]?.id).toBe(sent.id);

    // And it is parked on the DLQ stream rather than lost.
    const dlq = await redis.xrange(dlqKey('message.created'), '-', '+');
    expect(dlq.length).toBe(1);

    await sub.close();
  });

  test('acks an unparseable entry so it cannot wedge the group', async () => {
    const malformed: string[] = [];
    const bus = new RedisStreamsEventBus(redis, {
      blockMs: 100,
      onMalformed: (_key, id) => malformed.push(id),
    });
    const seen: ProtonEvent[] = [];

    const sub = bus.subscribe('junk', ['message.created'], async (e) => {
      seen.push(e);
    });

    await redis.xadd('proton:events:message.created', '*', 'event', '{not json');
    await bus.publish(event());

    // The good event still arrives — the bad one did not block the stream.
    await waitFor(() => seen.length === 1 && malformed.length === 1);
    expect(malformed).toHaveLength(1);

    await sub.close();
  });
});
