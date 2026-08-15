import type { EventType, ProtonEvent } from './types.ts';

export interface Subscription {
  readonly group: string;
  /**
   * Resolves once the subscription is actually consuming.
   *
   * Matters only for a group created at `'$'`, which anchors to the stream's
   * last id at creation time: anything published between `subscribe()` returning
   * and the group existing is invisible to it forever, with no cursor to fall
   * back on. A process that publishes into its own subscription must await this
   * first. One consuming another process's stream need not.
   *
   * Optional so a test double need not implement it.
   */
  readonly ready?: Promise<void>;
  /** Stop consuming and release the connection. In-flight handlers are awaited. */
  close(): Promise<void>;
}

/**
 * Where a consumer group starts reading when it is created for the first time.
 *
 * `'0'` is the whole retained stream; `'$'` is only what is published from now
 * on. It applies exactly once per group — a restart resumes from the group's own
 * cursor regardless.
 */
export type GroupStartId = '0' | '$';

export interface SubscribeOptions {
  /**
   * Start id for this subscription's group on first creation.
   *
   * A group added to a deployment that has already been running should pass
   * `'$'`. Streams are never trimmed, so `'0'` replays the entire retained
   * history, and any entry older than the executor's dedupe TTL is re-executed
   * rather than deduped — the difference between a new consumer catching up and
   * a new consumer acting on a backlog of events the guild has long forgotten
   * (I4).
   */
  startId?: GroupStartId;
}

/**
 * Verbatim from PLAN.md §4-P1.
 *
 * Delivery is **at-least-once**: a handler that throws leaves the message
 * unacknowledged so it is redelivered, and gateway RESUME replays dispatches
 * anyway. Effectively-once is the caller's job, via the idempotency key on
 * `ProtonEvent.id` (I4) — it is deliberately not hidden inside the bus, because
 * "exactly once" would be a lie at this layer.
 *
 * Retry/backoff and dead-lettering are behaviours of the implementation, not
 * extra surface on this interface.
 */
export interface EventBus {
  publish(e: ProtonEvent): Promise<void>;
  subscribe(
    group: string,
    types: EventType[],
    handler: (e: ProtonEvent) => Promise<void>,
    options?: SubscribeOptions,
  ): Subscription;
}
