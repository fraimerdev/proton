import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import type { SubscribeOptions } from '../../src/events/bus.ts';
import { RedisStreamsEventBus, streamKey } from '../../src/events/redis-streams.ts';
import type { ProtonEvent } from '../../src/events/types.ts';

const DAY = 86_400_000;

class FakeRedis {
  readonly added: unknown[][] = [];
  readonly trimmed: unknown[][] = [];
  readonly keys: string[];

  constructor(keys: string[] = []) {
    this.keys = keys;
  }

  async xadd(...args: unknown[]): Promise<string> {
    this.added.push(args);
    return '1-0';
  }

  async scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _size: number,
  ): Promise<[string, string[]]> {
    const prefix = pattern.slice(0, -1);
    return ['0', this.keys.filter((key) => key.startsWith(prefix))];
  }

  async xtrim(...args: unknown[]): Promise<number> {
    this.trimmed.push(args);
    return 0;
  }
}

function cutoff(args: unknown[]): number {
  return Number(args[3]);
}

describe('event stream retention', () => {
  test('publishing trims entries older than a day by default', async () => {
    const redis = new FakeRedis();
    const bus = new RedisStreamsEventBus(redis as unknown as Redis);
    const before = Date.now();

    await bus.publish({
      id: 'e1',
      type: 'message.created',
      guildId: '900000000000000001',
      occurredAt: before,
      payload: { content: 'hello' },
    });

    const [args] = redis.added;
    expect(args?.slice(0, 3)).toEqual(['proton:events:message.created', 'MINID', '~']);
    expect(args?.[4]).toBe('*');
    expect(cutoff(args ?? [])).toBeGreaterThanOrEqual(before - DAY);
    expect(cutoff(args ?? [])).toBeLessThanOrEqual(Date.now() - DAY);
  });

  test('the retention window is configurable', async () => {
    const redis = new FakeRedis();
    const bus = new RedisStreamsEventBus(redis as unknown as Redis, { retentionMs: 60_000 });
    const before = Date.now();

    await bus.publish({
      id: 'e1',
      type: 'message.created',
      guildId: null,
      occurredAt: before,
      payload: {},
    });

    expect(cutoff(redis.added[0] ?? [])).toBeGreaterThanOrEqual(before - 60_000);
  });

  test('trim sweeps every event stream exactly to a day and every dead-letter stream to a week', async () => {
    const redis = new FakeRedis([
      'proton:events:message.created',
      'proton:events:member.joined',
      'proton:dlq:message.created',
      'proton:gateway:session',
    ]);
    const bus = new RedisStreamsEventBus(redis as unknown as Redis);
    const before = Date.now();

    await bus.trim();

    const byKey = new Map(redis.trimmed.map((args) => [args[0], args]));
    expect([...byKey.keys()].sort()).toEqual([
      'proton:dlq:message.created',
      'proton:events:member.joined',
      'proton:events:message.created',
    ]);
    const joined = byKey.get('proton:events:member.joined') ?? [];
    expect(joined[1]).toBe('MINID');
    expect(Number(joined[2])).toBeGreaterThanOrEqual(before - DAY);
    const week = Number(byKey.get('proton:dlq:message.created')?.[2]);
    expect(week).toBeGreaterThanOrEqual(before - 7 * DAY);
    expect(week).toBeLessThanOrEqual(Date.now() - 7 * DAY);
  });
});

type Entry = [id: string, fields: string[]];

class FakeStreams {
  readonly acked: string[] = [];
  readonly claimed: string[] = [];
  readonly calls: string[] = [];
  readonly #entries = new Map<string, Entry[]>();
  readonly #delivered = new Set<string>();
  readonly #pendingIdleMs: number | null;

  constructor(options: { pendingIdleMs?: number } = {}) {
    this.#pendingIdleMs = options.pendingIdleMs ?? null;
  }

  add(id: string): void {
    const key = streamKey('interaction.component');
    const event: ProtonEvent = {
      id,
      type: 'interaction.component',
      guildId: '900000000000000001',
      occurredAt: 1_770_000_000_000,
      payload: {},
    };
    const list = this.#entries.get(key) ?? [];
    list.push([`${list.length + 1}-0`, ['event', JSON.stringify(event)]]);
    this.#entries.set(key, list);
  }

  idOf(eventId: string): string | undefined {
    const list = this.#entries.get(streamKey('interaction.component')) ?? [];
    return list.find(([, fields]) => fields[1]?.includes(`"id":"${eventId}"`))?.[0];
  }

  duplicate(): this {
    return this;
  }

  disconnect(): void {
    this.calls.push('disconnect');
  }

  async xgroup(): Promise<string> {
    return 'OK';
  }

  async xreadgroup(...args: Array<string | number>): Promise<Array<[string, Entry[]]> | null> {
    const count = Number(args[args.indexOf('COUNT') + 1]);
    const at = args.indexOf('STREAMS') + 1;
    const keys = args.slice(at, at + (args.length - at) / 2).map(String);

    const reply = keys.flatMap((key): Array<[string, Entry[]]> => {
      const fresh = (this.#entries.get(key) ?? [])
        .filter(([id]) => !this.#delivered.has(`${key} ${id}`))
        .slice(0, count);
      for (const [id] of fresh) this.#delivered.add(`${key} ${id}`);
      return fresh.length > 0 ? [[key, fresh]] : [];
    });
    if (reply.length > 0) return reply;

    await Bun.sleep(2);
    return null;
  }

  async xpending(key: string): Promise<Array<[string, string, number, number]>> {
    const idle = this.#pendingIdleMs;
    if (idle === null) return [];

    return (this.#entries.get(key) ?? [])
      .filter(([id]) => this.#delivered.has(`${key} ${id}`) && !this.acked.includes(id))
      .map(([id]) => [id, 'consumer', idle, 1]);
  }

  async xclaim(key: string, _group: string, _consumer: string, _idle: number, id: string) {
    this.claimed.push(id);
    return (this.#entries.get(key) ?? []).filter(([entryId]) => entryId === id);
  }

  async xack(_key: string, _group: string, id: string): Promise<number> {
    this.acked.push(id);
    this.calls.push(`ack ${id}`);
    return 1;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting for the subscription');
    await Bun.sleep(1);
  }
}

function held(): { gate: Promise<void>; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { gate: promise, release: () => resolve() };
}

function subscribeTo(
  streams: FakeStreams,
  handler: (event: ProtonEvent) => Promise<void>,
  options: SubscribeOptions = {},
) {
  const bus = new RedisStreamsEventBus(streams as unknown as Redis, {
    blockMs: 2,
    claimIdleMs: 1,
  });
  return bus.subscribe('listener:moderation:interactions', ['interaction.component'], handler, {
    startId: '$',
    ...options,
  });
}

describe('a subscription that handles entries concurrently', () => {
  test('a slow handler does not hold up the entry behind it', async () => {
    const streams = new FakeStreams();
    streams.add('slow');
    streams.add('fast');
    const { gate, release } = held();
    const handled: string[] = [];

    const subscription = subscribeTo(
      streams,
      async (event) => {
        if (event.id === 'slow') await gate;
        handled.push(event.id);
      },
      { concurrency: 2 },
    );

    await waitFor(() => handled.includes('fast'));
    expect(handled).toEqual(['fast']);
    await waitFor(() => streams.acked.includes(streams.idOf('fast') ?? ''));
    expect(streams.acked).not.toContain(streams.idOf('slow'));

    release();
    await waitFor(() => handled.length === 2);
    await subscription.close();

    expect(streams.idOf('slow')).toBe('1-0');
    expect(streams.acked).toEqual(['2-0', '1-0']);
  });

  test('without a concurrency the group stays one entry at a time', async () => {
    const streams = new FakeStreams();
    streams.add('slow');
    streams.add('fast');
    const { gate, release } = held();
    const handled: string[] = [];

    const subscription = subscribeTo(streams, async (event) => {
      if (event.id === 'slow') await gate;
      handled.push(event.id);
    });

    await Bun.sleep(30);
    expect(handled).toEqual([]);

    release();
    await waitFor(() => handled.length === 2);
    await subscription.close();

    expect(handled).toEqual(['slow', 'fast']);
  });

  test('never runs more entries at once than its concurrency', async () => {
    const streams = new FakeStreams();
    for (const id of ['a', 'b', 'c', 'd', 'e']) streams.add(id);
    let running = 0;
    let most = 0;
    const handled: string[] = [];

    const subscription = subscribeTo(
      streams,
      async (event) => {
        running += 1;
        most = Math.max(most, running);
        await Bun.sleep(10);
        running -= 1;
        handled.push(event.id);
      },
      { concurrency: 2 },
    );

    await waitFor(() => handled.length === 5);
    await subscription.close();

    expect(most).toBe(2);
    expect(streams.acked).toHaveLength(5);
  });

  test('an entry still in flight is never claimed back and run a second time', async () => {
    const streams = new FakeStreams({ pendingIdleMs: 60_000 });
    streams.add('slow');
    const { gate, release } = held();
    let runs = 0;

    const subscription = subscribeTo(
      streams,
      async () => {
        runs += 1;
        await gate;
      },
      { concurrency: 2 },
    );

    await waitFor(() => runs === 1);
    await Bun.sleep(30);
    expect(streams.claimed).toEqual([]);

    release();
    await waitFor(() => streams.acked.length === 1);
    await subscription.close();

    expect(runs).toBe(1);
  });

  test('closing waits for the entries in flight to be acknowledged', async () => {
    const streams = new FakeStreams();
    streams.add('slow');
    const { gate, release } = held();
    let started = false;

    const subscription = subscribeTo(
      streams,
      async () => {
        started = true;
        await gate;
      },
      { concurrency: 4 },
    );

    await waitFor(() => started);
    const closing = subscription.close();
    release();
    await closing;

    expect(streams.calls).toEqual([`ack ${streams.idOf('slow')}`, 'disconnect']);
  });
});
