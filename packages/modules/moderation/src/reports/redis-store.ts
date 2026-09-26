import type { Redis } from 'ioredis';

export const REACTION_GATE_PREFIX = 'proton:moderation:reaction';
export const REACTION_GATE_TTL_MS = 10 * 60 * 1000;

export const PROMPT_SET_PREFIX = 'proton:moderation:prompts';

export type ReactionClaim = 'claimed' | 'redelivery' | 'duplicate';

export interface ReactionGate {
  claim(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    eventId: string,
  ): Promise<ReactionClaim>;
  release(guildId: string, channelId: string, messageId: string, userId: string): Promise<void>;
}

export function reactionGateKey(
  guildId: string,
  channelId: string,
  messageId: string,
  userId: string,
  prefix: string = REACTION_GATE_PREFIX,
): string {
  return `${prefix}:${guildId}:${channelId}:${messageId}:${userId}`;
}

export class RedisReactionGate implements ReactionGate {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { prefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? REACTION_GATE_PREFIX;
  }

  async claim(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    eventId: string,
  ): Promise<ReactionClaim> {
    const key = reactionGateKey(guildId, channelId, messageId, userId, this.#prefix);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const set = await this.#redis.set(key, eventId, 'PX', REACTION_GATE_TTL_MS, 'NX');
      if (set === 'OK') return 'claimed';

      const holder = await this.#redis.get(key);
      if (holder === eventId) return 'redelivery';
      if (holder !== null) return 'duplicate';
    }

    return 'duplicate';
  }

  async release(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
  ): Promise<void> {
    await this.#redis.del(reactionGateKey(guildId, channelId, messageId, userId, this.#prefix));
  }
}

export interface PromptRef {
  channelId: string;
  messageId: string;
  dueAt: number;
}

export interface PromptStore {
  record(guildId: string, channelId: string, messageId: string, dueAt: number): Promise<void>;
  remove(guildId: string, channelId: string, messageId: string): Promise<void>;
  overdue(guildId: string, now: number, limit: number): Promise<PromptRef[]>;
}

export function promptSetKey(guildId: string, prefix: string = PROMPT_SET_PREFIX): string {
  return `${prefix}:${guildId}`;
}

export class RedisPromptStore implements PromptStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { prefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? PROMPT_SET_PREFIX;
  }

  async record(
    guildId: string,
    channelId: string,
    messageId: string,
    dueAt: number,
  ): Promise<void> {
    await this.#redis.zadd(promptSetKey(guildId, this.#prefix), dueAt, `${channelId}:${messageId}`);
  }

  async remove(guildId: string, channelId: string, messageId: string): Promise<void> {
    await this.#redis.zrem(promptSetKey(guildId, this.#prefix), `${channelId}:${messageId}`);
  }

  async overdue(guildId: string, now: number, limit: number): Promise<PromptRef[]> {
    const flat = await this.#redis.zrangebyscore(
      promptSetKey(guildId, this.#prefix),
      '-inf',
      now,
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    );

    const prompts: PromptRef[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      const [channelId, messageId] = (flat[index] ?? '').split(':');
      const dueAt = Number(flat[index + 1]);
      if (channelId && messageId && Number.isFinite(dueAt)) {
        prompts.push({ channelId, messageId, dueAt });
      }
    }

    return prompts;
  }
}
