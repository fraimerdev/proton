import type { Redis } from 'ioredis';
import { COUNT_FLUSH_INTERVAL_MS } from './config.ts';

export const DIRTY_SET_PREFIX = 'proton:giveaways:dirty';
export const FLUSH_LEASE_PREFIX = 'proton:giveaways:flush';

// Per guild, not one global set: the flush job runs from a per-guild ModuleContext, so a shared
// set hands guild A's tick a giveaway belonging to guild B — and it would then be edited with the
// wrong guild's channel and accent colour.
export function dirtySetKey(guildId: string, prefix: string = DIRTY_SET_PREFIX): string {
  return `${prefix}:${guildId}`;
}

export interface DirtyCounts {
  /** Marks a giveaway's live count as stale. Called once per join, never per edit. */
  mark(guildId: string, giveawayId: string): Promise<void>;

  /** Every giveaway currently stale in this guild, without clearing them. */
  pending(guildId: string, limit: number): Promise<string[]>;

  /**
   * Wins the right to edit this message for one window. Returns false when another worker
   * already holds it — that is what keeps the budget at one edit per window per message
   * across a whole deployment, rather than one per window per process.
   */
  lease(giveawayId: string, ttlMs: number): Promise<boolean>;

  clear(guildId: string, giveawayId: string): Promise<void>;
}

export class RedisDirtyCounts implements DirtyCounts {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #leasePrefix: string;

  constructor(redis: Redis, options: { prefix?: string; leasePrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? DIRTY_SET_PREFIX;
    this.#leasePrefix = options.leasePrefix ?? FLUSH_LEASE_PREFIX;
  }

  async mark(guildId: string, giveawayId: string): Promise<void> {
    await this.#redis.sadd(dirtySetKey(guildId, this.#prefix), giveawayId);
  }

  async pending(guildId: string, limit: number): Promise<string[]> {
    const members = await this.#redis.srandmember(dirtySetKey(guildId, this.#prefix), limit);
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

  async clear(guildId: string, giveawayId: string): Promise<void> {
    await this.#redis.srem(dirtySetKey(guildId, this.#prefix), giveawayId);
  }
}

export class MemoryDirtyCounts implements DirtyCounts {
  readonly #dirty = new Map<string, Set<string>>();
  readonly #leases = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async mark(guildId: string, giveawayId: string): Promise<void> {
    const set = this.#dirty.get(guildId) ?? new Set<string>();
    set.add(giveawayId);
    this.#dirty.set(guildId, set);
  }

  async pending(guildId: string, limit: number): Promise<string[]> {
    return [...(this.#dirty.get(guildId) ?? [])].slice(0, limit);
  }

  async lease(giveawayId: string, ttlMs: number): Promise<boolean> {
    const held = this.#leases.get(giveawayId);
    const now = this.#now();

    if (held !== undefined && held > now) return false;

    this.#leases.set(giveawayId, now + ttlMs);
    return true;
  }

  async clear(guildId: string, giveawayId: string): Promise<void> {
    this.#dirty.get(guildId)?.delete(giveawayId);
  }
}

export interface FlushOutcome {
  considered: number;
  edited: number;
  skipped: number;
}

export interface FlushDeps {
  dirty: DirtyCounts;
  guildId: string;

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
  const ids = await deps.dirty.pending(deps.guildId, deps.batchSize ?? 100);

  let edited = 0;
  let skipped = 0;

  for (const giveawayId of ids) {
    if (!(await deps.dirty.lease(giveawayId, interval))) {
      skipped += 1;
      continue;
    }

    // Cleared before the edit, not after: a join that lands during the edit has to leave the
    // giveaway dirty again, or its entrant would never show up in the count.
    await deps.dirty.clear(deps.guildId, giveawayId);

    if (await deps.edit(giveawayId)) edited += 1;
  }

  return { considered: ids.length, edited, skipped };
}
