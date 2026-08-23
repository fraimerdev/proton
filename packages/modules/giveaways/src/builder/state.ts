import type { MultiplierMode } from '@proton/core';
import type { Redis } from 'ioredis';
import type { RequirementLogic, VerifyOn } from '../store.ts';

export const DRAFT_PREFIX = 'proton:giveaways:draft';

// Long enough to walk away mid-build and come back, short enough that an abandoned draft does not
// sit in Redis forever.
export const DRAFT_TTL_MS = 60 * 60 * 1000;

export interface DraftItem {
  providerId: string;
  config: Record<string, unknown>;
}

export interface DraftMultiplier extends DraftItem {
  mode: MultiplierMode;
}

export interface GiveawayDraft {
  guildId: string;
  channelId: string;
  hostId: string;

  title: string;
  description: string | null;
  durationMs: number;
  winnerCount: number;

  requirementLogic: RequirementLogic;
  verifyOn: VerifyOn;
  maxEntriesPerUser: number | null;
  claimWindowSeconds: number | null;

  requirements: DraftItem[];
  multipliers: DraftMultiplier[];

  updatedAt: number;
}

export interface DraftStore {
  get(key: string): Promise<GiveawayDraft | null>;
  put(key: string, draft: GiveawayDraft, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// One draft per host per guild. Keying by interaction or message would let a host accumulate
// half-built giveaways they can no longer see, and a custom_id has no room to carry the draft.
export function draftKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export function emptyDraft(
  guildId: string,
  channelId: string,
  hostId: string,
  defaults: { winnerCount: number; claimWindowSeconds?: number | null },
  now: number,
): GiveawayDraft {
  return {
    guildId,
    channelId,
    hostId,
    title: '',
    description: null,
    durationMs: 24 * 60 * 60 * 1000,
    winnerCount: defaults.winnerCount,
    requirementLogic: 'all',
    verifyOn: 'both',
    maxEntriesPerUser: null,
    claimWindowSeconds: defaults.claimWindowSeconds ?? null,
    requirements: [],
    multipliers: [],
    updatedAt: now,
  };
}

export class RedisDraftStore implements DraftStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { prefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? DRAFT_PREFIX;
  }

  async get(key: string): Promise<GiveawayDraft | null> {
    const raw = await this.#redis.get(`${this.#prefix}:${key}`);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as GiveawayDraft;
    } catch {
      // A draft written by an older shape is not worth a crash — the host starts again.
      return null;
    }
  }

  async put(key: string, draft: GiveawayDraft, ttlMs: number = DRAFT_TTL_MS): Promise<void> {
    await this.#redis.set(
      `${this.#prefix}:${key}`,
      JSON.stringify(draft),
      'PX',
      Math.max(1, Math.floor(ttlMs)),
    );
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(`${this.#prefix}:${key}`);
  }
}

export class MemoryDraftStore implements DraftStore {
  readonly #drafts = new Map<string, GiveawayDraft>();

  async get(key: string): Promise<GiveawayDraft | null> {
    return this.#drafts.get(key) ?? null;
  }

  async put(key: string, draft: GiveawayDraft): Promise<void> {
    this.#drafts.set(key, draft);
  }

  async delete(key: string): Promise<void> {
    this.#drafts.delete(key);
  }
}
