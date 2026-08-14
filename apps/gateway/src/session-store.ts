import type { Redis } from 'ioredis';

/** Matches @discordjs/ws's SessionInfo shape. */
export interface SessionInfo {
  sessionId: string;
  sequence: number;
  shardId: number;
  shardCount: number;
  resumeURL: string;
}

export const SESSION_PREFIX = 'proton:gateway:session';

/**
 * Shard session state in Redis (PLAN.md I13).
 *
 * This is what makes the gateway deployable independently of the workers. Session
 * starts are capped at 1000/day across all shards, so a gateway restart must
 * RESUME (op 6) from stored state rather than IDENTIFY (op 2) — and a worker
 * deploy, which never touches this process, must cost nothing at all.
 */
export class RedisSessionStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix: string = SESSION_PREFIX) {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  #key(shardId: number): string {
    return `${this.#prefix}:${shardId}`;
  }

  /** Passed to WebSocketManager as `retrieveSessionInfo`. */
  retrieveSessionInfo = async (shardId: number): Promise<SessionInfo | null> => {
    const raw = await this.#redis.get(this.#key(shardId));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as SessionInfo;
    } catch {
      // Corrupt state is worse than none: returning null forces a clean
      // IDENTIFY instead of a RESUME that Discord would reject anyway.
      return null;
    }
  };

  /** Passed to WebSocketManager as `updateSessionInfo`. */
  updateSessionInfo = async (shardId: number, info: SessionInfo | null): Promise<void> => {
    if (info === null) {
      await this.#redis.del(this.#key(shardId));
      return;
    }

    await this.#redis.set(this.#key(shardId), JSON.stringify(info));
  };

  async clear(shardId: number): Promise<void> {
    await this.#redis.del(this.#key(shardId));
  }
}
