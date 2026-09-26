import type { Redis } from 'ioredis';
import type { EventBus, GroupStartId, SubscribeOptions, Subscription } from './bus.ts';
import type { EventType, ProtonEvent } from './types.ts';

export const STREAM_PREFIX = 'proton:events';
export const DLQ_PREFIX = 'proton:dlq';

export const streamKey = (type: EventType): string => `${STREAM_PREFIX}:${type}`;
export const dlqKey = (type: EventType): string => `${DLQ_PREFIX}:${type}`;

const FIELD = 'event';

export interface RedisStreamsEventBusOptions {
  claimIdleMs?: number;

  groupStartId?: GroupStartId;

  maxDeliveries?: number;

  blockMs?: number;
  batchSize?: number;
  onDeadLetter?: (event: ProtonEvent, deliveries: number, group: string) => void;
  onHandlerError?: (event: ProtonEvent, error: unknown, group: string) => void;

  onSubscriptionError?: (group: string, error: unknown) => void;

  onMalformed?: (streamKey: string, id: string) => void;

  retentionMs?: number;
  deadLetterRetentionMs?: number;
}

type CallbackKeys = 'onDeadLetter' | 'onHandlerError' | 'onMalformed' | 'onSubscriptionError';

interface ResolvedOptions extends Required<Omit<RedisStreamsEventBusOptions, CallbackKeys>> {
  onDeadLetter: ((event: ProtonEvent, deliveries: number, group: string) => void) | undefined;
  onHandlerError: ((event: ProtonEvent, error: unknown, group: string) => void) | undefined;
  onMalformed: ((streamKey: string, id: string) => void) | undefined;
  onSubscriptionError: ((group: string, error: unknown) => void) | undefined;
}

function resolve(options: RedisStreamsEventBusOptions): ResolvedOptions {
  return {
    claimIdleMs: options.claimIdleMs ?? 30_000,

    groupStartId: options.groupStartId ?? '0',
    maxDeliveries: options.maxDeliveries ?? 5,
    blockMs: options.blockMs ?? 500,
    batchSize: options.batchSize ?? 16,
    retentionMs: options.retentionMs ?? 86_400_000,
    deadLetterRetentionMs: options.deadLetterRetentionMs ?? 7 * 86_400_000,
    onDeadLetter: options.onDeadLetter,
    onHandlerError: options.onHandlerError,
    onMalformed: options.onMalformed,
    onSubscriptionError: options.onSubscriptionError,
  };
}

type StreamEntry = [id: string, fields: string[]];
type StreamReadReply = Array<[key: string, entries: StreamEntry[]]> | null;
type PendingEntry = [id: string, consumer: string, idleMs: number, deliveries: number];

class StreamSubscription implements Subscription {
  readonly group: string;

  #running = true;
  #loop: Promise<void>;
  readonly #redis: Redis;
  readonly #types: readonly EventType[];
  readonly #consumer: string;
  readonly #handler: (e: ProtonEvent) => Promise<void>;
  readonly #opts: ResolvedOptions;
  readonly #startId: GroupStartId;
  readonly #concurrency: number;
  readonly #inflight = new Map<string, Promise<void>>();
  #ensured = false;
  readonly #ready = Promise.withResolvers<void>();

  constructor(
    redis: Redis,
    group: string,
    types: readonly EventType[],
    consumer: string,
    handler: (e: ProtonEvent) => Promise<void>,
    opts: ResolvedOptions,
    startId: GroupStartId,
    concurrency: number,
  ) {
    this.#redis = redis;
    this.group = group;
    this.#types = types;
    this.#consumer = consumer;
    this.#handler = handler;
    this.#opts = opts;
    this.#startId = startId;
    this.#concurrency = concurrency;
    this.#loop = this.#run();
  }

  async close(): Promise<void> {
    this.#running = false;
    await this.#loop.catch(() => undefined);
    this.#redis.disconnect();
  }

  async #run(): Promise<void> {
    while (this.#running) {
      try {
        await this.#ensureGroups();
        await this.#reclaimStale();
        if (!this.#running) break;
        await this.#readNew();
      } catch (error) {
        if (!this.#running) break;

        if (String(error).includes('NOGROUP')) this.#ensured = false;

        this.#opts.onSubscriptionError?.(this.group, error);

        await Bun.sleep(50);
      }
    }

    await Promise.allSettled(this.#inflight.values());
  }

  async #ensureGroups(): Promise<void> {
    if (this.#ensured) return;

    for (const type of this.#types) {
      try {
        await this.#redis.xgroup('CREATE', streamKey(type), this.group, this.#startId, 'MKSTREAM');
      } catch (error) {
        if (!String(error).includes('BUSYGROUP')) throw error;
      }
    }

    this.#ensured = true;
    this.#ready.resolve();
  }

  get ready(): Promise<void> {
    return this.#ready.promise;
  }

  async #reclaimStale(): Promise<void> {
    for (const type of this.#types) {
      if (!this.#running) return;
      const key = streamKey(type);

      const pending = (await this.#redis.xpending(
        key,
        this.group,
        'IDLE',
        this.#opts.claimIdleMs,
        '-',
        '+',
        this.#opts.batchSize + this.#inflight.size,
      )) as PendingEntry[] | null;

      if (!pending?.length) continue;

      for (const [id, , , deliveries] of pending) {
        // In flight here past claimIdleMs: claiming it again would run it twice.
        if (this.#inflight.has(slotOf(key, id))) continue;

        if (deliveries > this.#opts.maxDeliveries) {
          await this.#deadLetter(type, key, id, deliveries);
          continue;
        }

        const claimed = (await this.#redis.xclaim(
          key,
          this.group,
          this.#consumer,
          this.#opts.claimIdleMs,
          id,
        )) as StreamEntry[] | null;

        for (const entry of claimed ?? []) {
          await this.#dispatch(key, entry);
        }
      }
    }
  }

  async #readNew(): Promise<void> {
    const room = this.#concurrency - this.#inflight.size;
    if (this.#concurrency > 1 && room <= 0) {
      await Promise.race(this.#inflight.values());
      return;
    }

    const keys = this.#types.map(streamKey);
    const reply = (await this.#redis.xreadgroup(
      'GROUP',
      this.group,
      this.#consumer,
      'COUNT',
      this.#concurrency > 1 ? Math.min(this.#opts.batchSize, room) : this.#opts.batchSize,
      'BLOCK',
      this.#opts.blockMs,
      'STREAMS',
      ...keys,
      ...keys.map(() => '>'),
    )) as StreamReadReply;

    if (!reply) return;

    for (const [key, entries] of reply) {
      for (const entry of entries) {
        if (!this.#running) return;
        await this.#dispatch(key, entry);
      }
    }
  }

  async #dispatch(key: string, entry: StreamEntry): Promise<void> {
    if (this.#concurrency <= 1) {
      await this.#handleEntry(key, entry);
      return;
    }

    while (this.#inflight.size >= this.#concurrency) {
      await Promise.race(this.#inflight.values());
    }

    const slot = slotOf(key, entry[0]);
    const running = this.#handleEntry(key, entry)
      .catch((error: unknown) => this.#opts.onSubscriptionError?.(this.group, error))
      .finally(() => this.#inflight.delete(slot));
    this.#inflight.set(slot, running);
  }

  async #handleEntry(key: string, [id, fields]: StreamEntry): Promise<void> {
    const event = parseEntry(fields);

    if (!event) {
      this.#opts.onMalformed?.(key, id);
      await this.#redis.xack(key, this.group, id);
      return;
    }

    try {
      await this.#handler(event);
      await this.#redis.xack(key, this.group, id);
    } catch (error) {
      this.#opts.onHandlerError?.(event, error, this.group);
    }
  }

  async #deadLetter(type: EventType, key: string, id: string, deliveries: number): Promise<void> {
    const range = (await this.#redis.xrange(key, id, id)) as StreamEntry[];
    const entry = range[0];

    if (entry) {
      const event = parseEntry(entry[1]);
      await this.#redis.xadd(
        dlqKey(type),
        'MINID',
        '~',
        oldestKept(this.#opts.deadLetterRetentionMs),
        '*',
        FIELD,
        entry[1][1] ?? '',
      );
      if (event) this.#opts.onDeadLetter?.(event, deliveries, this.group);
    }

    await this.#redis.xack(key, this.group, id);
  }
}

const oldestKept = (retentionMs: number): string => String(Date.now() - retentionMs);

const slotOf = (key: string, id: string): string => `${key} ${id}`;

function parseEntry(fields: string[]): ProtonEvent | null {
  const index = fields.indexOf(FIELD);
  const raw = index >= 0 ? fields[index + 1] : undefined;
  if (!raw) return null;

  try {
    return JSON.parse(raw) as ProtonEvent;
  } catch {
    return null;
  }
}

export class RedisStreamsEventBus implements EventBus {
  readonly #redis: Redis;
  readonly #opts: ResolvedOptions;
  readonly #subscriptions = new Set<StreamSubscription>();

  constructor(redis: Redis, options: RedisStreamsEventBusOptions = {}) {
    this.#redis = redis;
    this.#opts = resolve(options);
  }

  async publish(event: ProtonEvent): Promise<void> {
    await this.#redis.xadd(
      streamKey(event.type),
      'MINID',
      '~',
      oldestKept(this.#opts.retentionMs),
      '*',
      FIELD,
      JSON.stringify(event),
    );
  }

  async trim(): Promise<void> {
    const sweeps = [
      [STREAM_PREFIX, this.#opts.retentionMs],
      [DLQ_PREFIX, this.#opts.deadLetterRetentionMs],
    ] as const;

    for (const [prefix, retentionMs] of sweeps) {
      let cursor = '0';
      do {
        const [next, keys] = await this.#redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
        cursor = next;
        for (const key of keys) {
          await this.#redis.xtrim(key, 'MINID', oldestKept(retentionMs));
        }
      } while (cursor !== '0');
    }
  }

  subscribe(
    group: string,
    types: EventType[],
    handler: (e: ProtonEvent) => Promise<void>,
    options: SubscribeOptions = {},
  ): Subscription {
    const connection = this.#redis.duplicate();
    const consumer = `${group}-${crypto.randomUUID().slice(0, 8)}`;
    const concurrency = options.concurrency ?? 1;

    const subscription = new StreamSubscription(
      connection,
      group,
      types,
      consumer,
      handler,
      this.#opts,
      options.startId ?? this.#opts.groupStartId,
      Number.isInteger(concurrency) && concurrency > 1 ? concurrency : 1,
    );
    this.#subscriptions.add(subscription);
    return subscription;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#subscriptions].map((s) => s.close()));
    this.#subscriptions.clear();
  }
}
