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

function pingEvent(): ProtonEvent {
  const event = normalise(dispatch('interactionCreatePing'));
  if (!event) throw new Error('fixture did not normalise');
  return event;
}

describe('worker redelivery (Gate 0 acceptance)', () => {
  test('a killed worker’s in-flight event is redelivered and handled once', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100, claimIdleMs: 300 });
    const event = pingEvent();
    await bus.publish(event);

    const child = Bun.spawn(['bun', `${import.meta.dir}/kill-worker-child.ts`], {
      env: { ...process.env, REDIS_URL: url },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    await waitFor(async () => (await redis.get('child:received')) === event.id);
    const exitCode = await child.exited;

    expect(await redis.get('child:received')).toBe(event.id);
    expect(exitCode).not.toBe(0);

    const pending = await redis.xpending('proton:events:interaction.command', 'killgroup');
    expect((pending as unknown as [number])[0]).toBe(1);

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

    await Bun.sleep(800);
    expect(handled).toBe(0);

    await sub.close();
    await bus.close();
  }, 120_000);
});
