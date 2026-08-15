import type { Redis } from 'ioredis';
import type { BlocklistInstall, BlocklistStats, BlocklistStore } from './store.ts';

export const BLOCKLIST_PREFIX = 'proton:phishing';

/**
 * How long a cached list outlives its last refresh.
 *
 * Not a cache-invalidation TTL — the refresh job overwrites the key long before
 * this — but a **staleness ceiling**. If the refresher dies (a bad deploy, a
 * queue that never registered), the list would otherwise sit in Redis forever
 * and Proton would keep enforcing a blocklist from an arbitrarily distant past
 * while reporting itself healthy. Expiring it converts a silent, invisible
 * failure into the loud degraded mode the module already handles and reports.
 *
 * 24h against an hourly refresh is 24 consecutive missed refreshes before the
 * list is dropped, which is well past "a feed had a bad afternoon".
 */
export const BLOCKLIST_TTL_MS = 24 * 60 * 60 * 1000;

/** Redis refuses arbitrarily long argument lists; the set is built in slices. */
const SADD_CHUNK = 4_000;

interface StoredMeta {
  refreshedAt?: number;
  feeds?: string[];
  failures?: { url: string; reason: string }[];
}

export interface RedisBlocklistStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

/**
 * The blocklist as a Redis set.
 *
 * A set rather than an in-process `Set<string>` for two reasons. Every worker
 * replica sees the same list the instant one of them refreshes it, so a rolling
 * deploy cannot leave half the fleet enforcing a different list; and `SMISMEMBER`
 * answers every candidate a message produced in a single round trip, so the
 * per-message cost is one command regardless of how many domains are cached.
 */
export class RedisBlocklistStore implements BlocklistStore {
  readonly #redis: Redis;
  readonly #domainsKey: string;
  readonly #metaKey: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: RedisBlocklistStoreOptions = {}) {
    const prefix = options.keyPrefix ?? BLOCKLIST_PREFIX;
    this.#redis = redis;
    this.#domainsKey = `${prefix}:domains`;
    this.#metaKey = `${prefix}:meta`;
    this.#ttlMs = options.ttlMs ?? BLOCKLIST_TTL_MS;
  }

  async replace(install: BlocklistInstall): Promise<number> {
    if (install.domains.length === 0) {
      // The port documents this as the caller's job. Reaching here means a
      // caller skipped the guard in `refreshBlocklist`, which would install
      // "nothing is phishing" over a working list.
      throw new Error(
        'RedisBlocklistStore.replace was called with no domains, which would disarm the ' +
          'phishing module. A refresh that produced nothing must be reported, not stored.',
      );
    }

    // A per-call staging key, so two refreshes racing (two replicas, overlapping
    // ticks) each build their own set and the loser is simply overwritten —
    // rather than the two interleaving SADDs into one shared half-built key.
    const staging = `${this.#domainsKey}:staging:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    try {
      for (let index = 0; index < install.domains.length; index += SADD_CHUNK) {
        const chunk = install.domains.slice(index, index + SADD_CHUNK);
        await this.#redis.sadd(staging, ...chunk);
      }
      // Bounded before the swap, so a crash between here and the RENAME leaks a
      // key that disappears on its own rather than one that lives forever.
      await this.#redis.pexpire(staging, this.#ttlMs);

      const meta: StoredMeta = {
        refreshedAt: install.refreshedAt.getTime(),
        feeds: [...install.feeds],
        failures: install.failures.map((failure) => ({ ...failure })),
      };

      // RENAME is the atomic swap: readers see the old complete list until this
      // instant and the new complete list after it, never a partial one.
      await this.#redis
        .multi()
        .rename(staging, this.#domainsKey)
        .pexpire(this.#domainsKey, this.#ttlMs)
        .set(this.#metaKey, JSON.stringify(meta), 'PX', this.#ttlMs)
        .exec();

      return install.domains.length;
    } catch (error) {
      // Best effort — the staging key already carries a TTL, so a failure here
      // costs nothing but leaves the old list intact, which is the point.
      await this.#redis.del(staging).catch(() => undefined);
      throw error;
    }
  }

  async lookup(candidates: readonly string[]): Promise<string | null> {
    if (candidates.length === 0) return null;

    const flags = await this.#redis.smismember(this.#domainsKey, ...candidates);

    for (const [index, flag] of flags.entries()) {
      if (flag === 1) return candidates[index] ?? null;
    }
    return null;
  }

  async stats(): Promise<BlocklistStats> {
    const [size, raw] = await Promise.all([
      this.#redis.scard(this.#domainsKey),
      this.#redis.get(this.#metaKey),
    ]);

    let meta: StoredMeta = {};
    if (raw !== null) {
      try {
        meta = JSON.parse(raw) as StoredMeta;
      } catch {
        // An unreadable meta blob must not hide the one number that matters.
        meta = {};
      }
    }

    return {
      size,
      refreshedAt: meta.refreshedAt === undefined ? null : new Date(meta.refreshedAt),
      feeds: meta.feeds ?? [],
      failures: meta.failures ?? [],
    };
  }
}
