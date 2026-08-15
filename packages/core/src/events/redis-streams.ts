import type { Redis } from 'ioredis';
import type { EventBus, GroupStartId, SubscribeOptions, Subscription } from './bus.ts';
import type { EventType, ProtonEvent } from './types.ts';

export const STREAM_PREFIX = 'proton:events';
export const DLQ_PREFIX = 'proton:dlq';

export const streamKey = (type: EventType): string => `${STREAM_PREFIX}:${type}`;
export const dlqKey = (type: EventType): string => `${DLQ_PREFIX}:${type}`;

const FIELD = 'event';

export interface RedisStreamsEventBusOptions {
  /**
   * How long a pending entry may sit unacknowledged before another consumer may
   * reclaim it. This is the window in which a killed worker's in-flight event is
   * invisible, so it trades recovery latency against tolerating slow handlers.
   */
  claimIdleMs?: number;
  /** Default start id for groups this bus creates. Per-subscription override wins. */
  groupStartId?: GroupStartId;
  /** Deliveries after which an event is dead-lettered rather than retried forever. */
  maxDeliveries?: number;
  /** Blocking read timeout. Also bounds how long `close()` takes. */
  blockMs?: number;
  batchSize?: number;
  onDeadLetter?: (event: ProtonEvent, deliveries: number, group: string) => void;
  onHandlerError?: (event: ProtonEvent, error: unknown, group: string) => void;
  /**
   * The read loop itself failed — a connection hiccup, a vanished group, an ACL
   * change. Carries the group, because with one group per module "something
   * failed" is not actionable and "listener:antinuke failed" is.
   */
  onSubscriptionError?: (group: string, error: unknown) => void;
  /** Entries that cannot be parsed at all — acked so they cannot wedge the group. */
  onMalformed?: (streamKey: string, id: string) => void;
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
    // Unchanged default: existing groups (`worker`, `guild-state`) keep reading
    // from the start of the stream exactly as they did before.
    groupStartId: options.groupStartId ?? '0',
    maxDeliveries: options.maxDeliveries ?? 5,
    blockMs: options.blockMs ?? 500,
    batchSize: options.batchSize ?? 16,
    onDeadLetter: options.onDeadLetter,
    onHandlerError: options.onHandlerError,
    onMalformed: options.onMalformed,
    onSubscriptionError: options.onSubscriptionError,
  };
}

/** ioredis types these replies as `unknown`; these narrow them in one place. */
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
  ) {
    this.#redis = redis;
    this.group = group;
    this.#types = types;
    this.#consumer = consumer;
    this.#handler = handler;
    this.#opts = opts;
    this.#startId = startId;
    this.#loop = this.#run();
  }

  async close(): Promise<void> {
    this.#running = false;
    await this.#loop.catch(() => undefined);
    this.#redis.disconnect();
  }

  /**
   * The read loop.
   *
   * Group creation is *inside* the loop's error handling, not before it. It used
   * to be a bare `await` ahead of the `while`, which had two consequences, both
   * silent. A Redis that was not up yet — entirely normal at boot — rejected the
   * promise this constructor never awaits, producing an unhandled rejection and
   * handing the caller a `Subscription` object that would never consume
   * anything. And because `#ensureGroups` ran exactly once, a group deleted
   * underneath a running subscription was never recreated: XREADGROUP answers
   * NOGROUP forever, the catch below swallows it, and the process looks healthy
   * while every consumer in it is deaf. That was survivable with three
   * subscriptions; it is not with one per module.
   *
   * `#ensured` makes the common path free — after the first success it is a
   * boolean check, not a round trip.
   */
  async #run(): Promise<void> {
    while (this.#running) {
      try {
        await this.#ensureGroups();
        await this.#reclaimStale();
        if (!this.#running) break;
        await this.#readNew();
      } catch (error) {
        if (!this.#running) break;

        // NOGROUP means the group vanished — re-create it on the next pass
        // rather than spinning against a group that is not there.
        if (String(error).includes('NOGROUP')) this.#ensured = false;

        this.#opts.onSubscriptionError?.(this.group, error);
        // Pause briefly so a persistent failure cannot become a hot loop.
        await Bun.sleep(50);
      }
    }
  }

  async #ensureGroups(): Promise<void> {
    if (this.#ensured) return;

    for (const type of this.#types) {
      try {
        // MKSTREAM so a subscriber may start before the first publisher.
        await this.#redis.xgroup('CREATE', streamKey(type), this.group, this.#startId, 'MKSTREAM');
      } catch (error) {
        // Another process created it first; that is the normal case on restart.
        if (!String(error).includes('BUSYGROUP')) throw error;
      }
    }

    // Only after every group exists, so a failure part-way through is retried
    // from the top rather than leaving some streams unsubscribed.
    this.#ensured = true;
    this.#ready.resolve();
  }

  /**
   * Resolves once every group this subscription needs exists.
   *
   * A group created at `'$'` anchors to the stream's last id *at creation time*,
   * so anything published between `subscribe()` returning and the CREATE landing
   * is invisible to it forever — there is no cursor to fall back on. Callers that
   * publish into their own subscription (every integration test, and any process
   * that starts a publisher in the same breath as a consumer) need to await this
   * first. A long-running worker consuming another process's stream does not.
   */
  get ready(): Promise<void> {
    return this.#ready.promise;
  }

  /**
   * Recover entries a dead consumer read but never acknowledged.
   *
   * XPENDING rather than XAUTOCLAIM because only XPENDING reports the delivery
   * count, and that count is what distinguishes "retry this" from "this event
   * poisons every consumer that touches it, dead-letter it".
   */
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
        this.#opts.batchSize,
      )) as PendingEntry[] | null;

      if (!pending?.length) continue;

      for (const [id, , , deliveries] of pending) {
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
          await this.#handleEntry(key, entry);
        }
      }
    }
  }

  async #readNew(): Promise<void> {
    const keys = this.#types.map(streamKey);
    const reply = (await this.#redis.xreadgroup(
      'GROUP',
      this.group,
      this.#consumer,
      'COUNT',
      this.#opts.batchSize,
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
        await this.#handleEntry(key, entry);
      }
    }
  }

  async #handleEntry(key: string, [id, fields]: StreamEntry): Promise<void> {
    const event = parseEntry(fields);

    if (!event) {
      // Unparseable: ack it. Leaving it pending would make it reappear forever
      // and block nothing useful — it can never succeed.
      this.#opts.onMalformed?.(key, id);
      await this.#redis.xack(key, this.group, id);
      return;
    }

    try {
      await this.#handler(event);
      await this.#redis.xack(key, this.group, id);
    } catch (error) {
      // Deliberately NOT acked. The entry stays pending and is reclaimed after
      // claimIdleMs — this is the redelivery that Gate 0's kill-the-worker
      // criterion depends on.
      this.#opts.onHandlerError?.(event, error, this.group);
    }
  }

  async #deadLetter(type: EventType, key: string, id: string, deliveries: number): Promise<void> {
    const range = (await this.#redis.xrange(key, id, id)) as StreamEntry[];
    const entry = range[0];

    if (entry) {
      const event = parseEntry(entry[1]);
      await this.#redis.xadd(dlqKey(type), '*', FIELD, entry[1][1] ?? '');
      if (event) this.#opts.onDeadLetter?.(event, deliveries, this.group);
    }

    await this.#redis.xack(key, this.group, id);
  }
}

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

/**
 * Redis Streams implementation of the event bus (PLAN.md §2 locks this; NATS is
 * a possible future implementation behind the same interface).
 *
 * One stream per event type, so a consumer group reads only the types it asked
 * for rather than filtering client-side.
 */
export class RedisStreamsEventBus implements EventBus {
  readonly #redis: Redis;
  readonly #opts: ResolvedOptions;
  readonly #subscriptions = new Set<StreamSubscription>();

  constructor(redis: Redis, options: RedisStreamsEventBusOptions = {}) {
    this.#redis = redis;
    this.#opts = resolve(options);
  }

  async publish(event: ProtonEvent): Promise<void> {
    await this.#redis.xadd(streamKey(event.type), '*', FIELD, JSON.stringify(event));
  }

  subscribe(
    group: string,
    types: EventType[],
    handler: (e: ProtonEvent) => Promise<void>,
    options: SubscribeOptions = {},
  ): Subscription {
    // Blocking reads occupy a connection, so each subscription gets its own.
    const connection = this.#redis.duplicate();
    const consumer = `${group}-${crypto.randomUUID().slice(0, 8)}`;

    const subscription = new StreamSubscription(
      connection,
      group,
      types,
      consumer,
      handler,
      this.#opts,
      options.startId ?? this.#opts.groupStartId,
    );
    this.#subscriptions.add(subscription);
    return subscription;
  }

  /** Close every subscription this bus handed out. */
  async close(): Promise<void> {
    await Promise.all([...this.#subscriptions].map((s) => s.close()));
    this.#subscriptions.clear();
  }
}
