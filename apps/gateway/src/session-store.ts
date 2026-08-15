import type { Redis } from 'ioredis';

export interface SessionInfo {
  sessionId: string;
  sequence: number;
  shardId: number;
  shardCount: number;
  resumeURL: string;
}

export const SESSION_PREFIX = 'proton:gateway:session';

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

  retrieveSessionInfo = async (shardId: number): Promise<SessionInfo | null> => {
    const raw = await this.#redis.get(this.#key(shardId));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as SessionInfo;
    } catch {
      return null;
    }
  };

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
