import { describe, expect, test } from 'bun:test';
import { CachedXpEventStore, XP_EVENT_CACHE_TTL_MS } from '../src/xp-event-cache.ts';
import { FakeXpEventStore, GUILD, USER, xpEvent } from './fakes.ts';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60_000;

function cached(store: FakeXpEventStore) {
  let now = NOW;
  const cache = new CachedXpEventStore(store, { now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

describe('CachedXpEventStore', () => {
  test('reuses a guild’s events for 30 seconds, then reads again', async () => {
    const store = new FakeXpEventStore().seed(
      xpEvent({ startsAt: NOW - MINUTE, endsAt: NOW + MINUTE }),
    );
    const { cache, advance } = cached(store);

    await cache.overlapping(GUILD, NOW, NOW + 1);
    advance(XP_EVENT_CACHE_TTL_MS - 1);
    await cache.overlapping(GUILD, NOW, NOW + 1);
    expect(store.calls.filter((call) => call === 'overlapping')).toHaveLength(1);

    advance(1);
    await cache.overlapping(GUILD, NOW, NOW + 1);
    expect(store.calls.filter((call) => call === 'overlapping')).toHaveLength(2);
  });

  test('answers each window from the cached list, not the widest one', async () => {
    const store = new FakeXpEventStore().seed(
      xpEvent({ id: 'early', startsAt: NOW - 20 * MINUTE, endsAt: NOW - 10 * MINUTE }),
      xpEvent({ id: 'now', startsAt: NOW - MINUTE, endsAt: NOW + MINUTE }),
    );
    const { cache } = cached(store);

    expect((await cache.overlapping(GUILD, NOW, NOW + 1)).map((event) => event.id)).toEqual([
      'now',
    ]);
    expect(
      (await cache.overlapping(GUILD, NOW - 30 * MINUTE, NOW)).map((event) => event.id),
    ).toEqual(['early', 'now']);
  });

  test('a write through the cache forgets that guild at once', async () => {
    const store = new FakeXpEventStore();
    const { cache } = cached(store);

    expect(await cache.overlapping(GUILD, NOW, NOW + 1)).toEqual([]);

    await cache.create({
      guildId: GUILD,
      id: 'fresh',
      multiplier: 2,
      startsAt: NOW - 1,
      endsAt: NOW + MINUTE,
      createdBy: USER,
      now: NOW,
      maxPending: 5,
    });

    expect((await cache.overlapping(GUILD, NOW, NOW + 1)).map((event) => event.id)).toEqual([
      'fresh',
    ]);
  });

  test('a window older than the cache covers goes straight to the store', async () => {
    const store = new FakeXpEventStore();
    const { cache } = cached(store);

    await cache.overlapping(GUILD, NOW, NOW + 1);
    await cache.overlapping(GUILD, NOW - 3 * 24 * 60 * MINUTE, NOW);

    expect(store.calls.filter((call) => call === 'overlapping')).toHaveLength(2);
  });

  test('a failed read is not cached', async () => {
    const store = new FakeXpEventStore();
    let fail = true;
    const read = store.overlapping.bind(store);
    store.overlapping = async (guildId, from, to) => {
      if (fail) throw new Error('postgres is down');
      return read(guildId, from, to);
    };
    const { cache } = cached(store);

    await expect(cache.overlapping(GUILD, NOW, NOW + 1)).rejects.toThrow('postgres is down');

    fail = false;
    expect(await cache.overlapping(GUILD, NOW, NOW + 1)).toEqual([]);
  });
});
