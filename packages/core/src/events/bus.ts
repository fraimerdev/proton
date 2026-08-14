import type { EventType, ProtonEvent } from './types.ts';

export interface Subscription {
  readonly group: string;
  /** Stop consuming and release the connection. In-flight handlers are awaited. */
  close(): Promise<void>;
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
  ): Subscription;
}
