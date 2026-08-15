import type { Redis } from 'ioredis';
import type { BlocklistInstall, BlocklistStats, BlocklistStore } from './store.ts';

export const BLOCKLIST_PREFIX = 'proton:phishing';

export const BLOCKLIST_TTL_MS = 24 * 60 * 60 * 1000;

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
      throw new Error(
        'RedisBlocklistStore.replace was called with no domains, which would disarm the ' +
          'phishing module. A refresh that produced nothing must be reported, not stored.',
      );
    }

    const staging = `${this.#domainsKey}:staging:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    try {
      for (let index = 0; index < install.domains.length; index += SADD_CHUNK) {
        const chunk = install.domains.slice(index, index + SADD_CHUNK);
        await this.#redis.sadd(staging, ...chunk);
      }

      await this.#redis.pexpire(staging, this.#ttlMs);

      const meta: StoredMeta = {
        refreshedAt: install.refreshedAt.getTime(),
        feeds: [...install.feeds],
        failures: install.failures.map((failure) => ({ ...failure })),
      };

      await this.#redis
        .multi()
        .rename(staging, this.#domainsKey)
        .pexpire(this.#domainsKey, this.#ttlMs)
        .set(this.#metaKey, JSON.stringify(meta), 'PX', this.#ttlMs)
        .exec();

      return install.domains.length;
    } catch (error) {
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
