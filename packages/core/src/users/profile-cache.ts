import type { Redis } from 'ioredis';
import { z } from 'zod';

export const USER_PROFILE_PREFIX = 'proton:user';

export const USER_PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

export const CDN_BASE = 'https://cdn.discordapp.com';

export const userProfileSchema = z.object({
  id: z.string().min(1).max(100),
  username: z.string().min(1).max(64),
  globalName: z.string().max(64).nullable(),
  avatarUrl: z.string().max(512).nullable(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export interface UserProfileCache {
  get(userId: string): Promise<UserProfile | null>;

  put(profile: UserProfile, ttlMs?: number): Promise<void>;
}

export function avatarUrl(userId: string, hash: unknown, size = 64): string | null {
  if (typeof hash === 'string' && hash.length > 0) {
    const extension = hash.startsWith('a_') ? 'gif' : 'png';
    return `${CDN_BASE}/avatars/${userId}/${hash}.${extension}?size=${size}`;
  }

  let index = 0n;
  try {
    index = (BigInt(userId) >> 22n) % 6n;
  } catch {
    return null;
  }

  return `${CDN_BASE}/embed/avatars/${index}.png`;
}

export function toUserProfile(raw: unknown): UserProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const user = raw as Record<string, unknown>;

  const id = typeof user.id === 'string' ? user.id : null;
  const username = typeof user.username === 'string' ? user.username : null;
  if (!id || !username) return null;

  return {
    id,
    username,
    globalName: typeof user.global_name === 'string' ? user.global_name : null,
    avatarUrl: avatarUrl(id, user.avatar),
  };
}

export class RedisUserProfileCache implements UserProfileCache {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: { prefix?: string; ttlMs?: number } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? USER_PROFILE_PREFIX;
    this.#ttlMs = options.ttlMs ?? USER_PROFILE_TTL_MS;
  }

  #key(userId: string): string {
    return `${this.#prefix}:${userId}`;
  }

  async get(userId: string): Promise<UserProfile | null> {
    const raw = await this.#redis.get(this.#key(userId));
    if (raw === null) return null;

    try {
      const parsed = userProfileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async put(profile: UserProfile, ttlMs: number = this.#ttlMs): Promise<void> {
    await this.#redis.set(this.#key(profile.id), JSON.stringify(profile), 'PX', ttlMs);
  }
}
