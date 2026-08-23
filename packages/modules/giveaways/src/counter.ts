import type { Redis } from 'ioredis';
import { COUNT_FLUSH_INTERVAL_MS } from './config.ts';

export const DIRTY_SET_KEY = 'proton:giveaways:dirty';
export const FLUSH_LEASE_PREFIX = 'proton:giveaways:flush';

export interface DirtyCounts {
  /** Marks a giveaway's live count as stale. Called once per join, never per edit. */
  mark(giveawayId: string): Promise<void>;

  /** Every giveaway currently stale, without clearing them. */
  pending(limit: number): Promise<string[]>;

  /**
   * Wins the right to edit this message for one window. Returns false when another worker
   * already holds it — that is what keeps the budget at one edit per window per message
   * across a whole deployment, rather than one per window per process.
   */
  lease(giveawayId: string, ttlMs: number): Promise<boolean>;

  clear(giveawayId: string): Promise<void>;
}

export class RedisDirtyCounts implements DirtyCounts {
  readonly #redis: Redis;
  readonly #setKey: string;
  readonly #leasePrefix: string;

  constructor(redis: Redis, options: { setKey?: string; leasePrefix?: string } = {}) {
    this.#redis = redis;
    this.#setKey = options.setKey ?? DIRTY_SET_KEY;
    this.#leasePrefix = options.leasePrefix ?? FLUSH_LEASE_PREFIX;
  }

  async mark(giveawayId: string): Promise<void> {
    await this.#redis.sadd(this.#setKey, giveawayId);
  }

  async pending(limit: number): Promise<string[]> {
    const members = await this.#redis.srandmember(this.#setKey, limit);
    return Array.isArray(members) ? members : members === null ? [] : [members];
  }

  async lease(giveawayId: string, ttlMs: number): Promise<boolean> {
    const won = await this.#redis.set(
      `${this.#leasePrefix}:${giveawayId}`,
      '1',
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );

    return won === 'OK';
  }

  async clear(giveawayId: string): Promise<void> {
    await this.#redis.srem(this.#setKey, giveawayId);
  }
}

export class MemoryDirtyCounts implements DirtyCounts {
  readonly #dirty = new Set<string>();
  readonly #leases = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async mark(giveawayId: string): Promise<void> {
    this.#dirty.add(giveawayId);
  }

  async pending(limit: number): Promise<string[]> {
    return [...this.#dirty].slice(0, limit);
  }

  async lease(giveawayId: string, ttlMs: number): Promise<boolean> {
    const held = this.#leases.get(giveawayId);
    const now = this.#now();

    if (held !== undefined && held > now) return false;

    this.#leases.set(giveawayId, now + ttlMs);
    return true;
  }

  async clear(giveawayId: string): Promise<void> {
    this.#dirty.delete(giveawayId);
  }
}

export interface FlushOutcome {
  considered: number;
  edited: number;
  skipped: number;
}

export interface FlushDeps {
  dirty: DirtyCounts;

  /** Returns true when the message was actually edited. */
  edit(giveawayId: string): Promise<boolean>;

  intervalMs?: number;
  batchSize?: number;
}

/**
 * One pass of the debounced live-count updater.
 *
 * The dirty flag lives in Redis rather than in a process, so a worker restarting mid-giveaway
 * loses nothing: the flag is still set, and the next tick on any worker flushes it. The lease
 * expires on its own, so a worker that dies holding one blocks the message for one window, not
 * forever.
 */
export async function flushCounts(deps: FlushDeps): Promise<FlushOutcome> {
  const interval = deps.intervalMs ?? COUNT_FLUSH_INTERVAL_MS;
  const ids = await deps.dirty.pending(deps.batchSize ?? 100);

  let edited = 0;
  let skipped = 0;

  for (const giveawayId of ids) {
    if (!(await deps.dirty.lease(giveawayId, interval))) {
      skipped += 1;
      continue;
    }

    // Cleared before the edit, not after: a join that lands during the edit has to leave the
    // giveaway dirty again, or its entrant would never show up in the count.
    await deps.dirty.clear(giveawayId);

    if (await deps.edit(giveawayId)) edited += 1;
  }

  return { considered: ids.length, edited, skipped };
}
