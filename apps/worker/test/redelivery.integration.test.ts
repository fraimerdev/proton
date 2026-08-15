import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type ProtonEvent, RedisDedupeStore, RedisStreamsEventBus } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';

let container: StartedRedisContainer;
let redis: Redis;
let url: string;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  url = container.getConnectionUrl();
  redis = new Redis(url);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error('waitFor timed out');
}

/** The real interaction the ping slice handles, normalised exactly as in production. */
function pingEvent(): ProtonEvent {
  const event = normalise(dispatch('interactionCreatePing'));
  if (!event) throw new Error('fixture did not normalise');
  return event;
}

describe('worker redelivery (Gate 0 acceptance)', () => {
  /**
   * "Kill the worker mid-event; the event is redelivered and handled
   * effectively once."
   *
   * The first consumer is a separate OS process that is killed after reading the
   * event and before acknowledging it. A surviving consumer must reclaim the
   * pending entry, and the dedupe layer must ensure the side effect happens
   * exactly once across both deliveries.
   */
  test('a killed worker’s in-flight event is redelivered and handled once', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100, claimIdleMs: 300 });
    const event = pingEvent();
    await bus.publish(event);

    // 1. A real process picks it up and dies before acking.
    const child = Bun.spawn(['bun', `${import.meta.dir}/kill-worker-child.ts`], {
      env: { ...process.env, REDIS_URL: url },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    await waitFor(async () => (await redis.get('child:received')) === event.id);
    const exitCode = await child.exited;

    expect(await redis.get('child:received')).toBe(event.id);
    expect(exitCode).not.toBe(0);

    // 2. The entry is now pending against a consumer that no longer exists.
    const pending = await redis.xpending('proton:events:interaction.command', 'killgroup');
    expect((pending as unknown as [number])[0]).toBe(1);

    // 3. A surviving worker reclaims it and performs the side effect, guarded
    //    by the idempotency key exactly as the executor does.
    const dedupe = new RedisDedupeStore(redis);
    const survivor = new RedisStreamsEventBus(redis, { blockMs: 100, claimIdleMs: 300 });
    let handled = 0;

    const sub = survivor.subscribe('killgroup', ['interaction.command'], async (e) => {
      handled += 1;
      if (await dedupe.claim(e.id, 60_000)) {
        await redis.incr('side-effect-count');
      }
    });

    await waitFor(async () => (await redis.get('side-effect-count')) === '1');

    // 4. And a further redelivery of the same event changes nothing.
    await survivor.publish(event);
    await Bun.sleep(600);

    expect(await redis.get('side-effect-count')).toBe('1');
    expect(handled).toBeGreaterThanOrEqual(1);

    await sub.close();
    await bus.close();
  }, 120_000);

  test('a pending entry is only reclaimed after the idle window, not instantly', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50, claimIdleMs: 5_000 });
    await bus.publish(pingEvent());

    const child = Bun.spawn(['bun', `${import.meta.dir}/kill-worker-child.ts`], {
      env: { ...process.env, REDIS_URL: url },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await waitFor(async () => (await redis.get('child:received')) !== null);
    await child.exited;

    let handled = 0;
    const sub = bus.subscribe('killgroup', ['interaction.command'], async () => {
      handled += 1;
    });

    // Long idle window: a slow-but-alive handler must not have its work stolen.
    await Bun.sleep(800);
    expect(handled).toBe(0);

    await sub.close();
    await bus.close();
  }, 120_000);
});
