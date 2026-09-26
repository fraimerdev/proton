import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { decodeSeen, RedisPresenceStore } from '../src/redis-store.ts';

const GUILD = '900000000000000001';
const BEN = '700000000000000002';
const CREATED = '600000000000000001';

function fakeRedis() {
  const values = new Map<string, string>();
  const expiries = new Map<string, number>();

  const set = (key: string, value: string, _px: 'PX', ms: number, nx?: 'NX') => {
    if (nx === 'NX' && values.has(key)) return null;
    values.set(key, value);
    expiries.set(key, ms);
    return 'OK';
  };

  const incr = (key: string) => {
    const next = Number(values.get(key) ?? 0) + 1;
    values.set(key, String(next));
    return next;
  };

  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, px: 'PX', ms: number, nx?: 'NX') =>
      set(key, value, px, ms, nx),
    multi() {
      const queued: Array<() => unknown> = [];
      const chain = {
        set(key: string, value: string, px: 'PX', ms: number, nx?: 'NX') {
          queued.push(() => set(key, value, px, ms, nx));
          return chain;
        },
        incr(key: string) {
          queued.push(() => incr(key));
          return chain;
        },
        exec: async () => queued.map((run) => [null, run()]),
      };
      return chain;
    },
  };

  return { redis: redis as unknown as Redis, values, expiries };
}

describe('where a member was last seen', () => {
  test('is stored with the moment of the event that put them there', async () => {
    const { redis } = fakeRedis();
    const store = new RedisPresenceStore(redis);

    await store.place(GUILD, BEN, CREATED, 1_700_000_000_000);

    expect(await store.where(GUILD, BEN)).toEqual({ channelId: CREATED, at: 1_700_000_000_000 });
    expect(await store.locate(GUILD, BEN)).toBe(CREATED);
  });

  test('a member who left keeps a stamped entry that locates nowhere', async () => {
    const { redis, expiries } = fakeRedis();
    const store = new RedisPresenceStore(redis, { ttlMs: 5_000 });

    await store.place(GUILD, BEN, null, 42);

    expect(await store.where(GUILD, BEN)).toEqual({ channelId: null, at: 42 });
    expect(await store.locate(GUILD, BEN)).toBeNull();
    expect([...expiries.values()]).toEqual([5_000]);
  });

  test('an entry written before stamps existed is read as older than any event', () => {
    expect(decodeSeen(CREATED)).toEqual({ channelId: CREATED, at: 0 });
    expect(decodeSeen(`${CREATED}|nonsense`)).toEqual({ channelId: CREATED, at: 0 });
  });

  test('nobody seen is null, not an empty location', async () => {
    const { redis } = fakeRedis();

    expect(await new RedisPresenceStore(redis).where(GUILD, BEN)).toBeNull();
  });
});

describe('refused deletes', () => {
  test('are counted per row inside one window', async () => {
    const { redis, expiries } = fakeRedis();
    const store = new RedisPresenceStore(redis);

    expect(await store.deleteRefusals(GUILD, 'row-1')).toBe(0);
    expect(await store.refusedDelete(GUILD, 'row-1', 3_600_000)).toBe(1);
    expect(await store.refusedDelete(GUILD, 'row-1', 3_600_000)).toBe(2);
    expect(await store.deleteRefusals(GUILD, 'row-1')).toBe(2);
    expect(await store.deleteRefusals(GUILD, 'row-2')).toBe(0);
    expect([...expiries.values()]).toEqual([3_600_000]);
  });
});
