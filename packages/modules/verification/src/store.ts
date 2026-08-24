import { snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const QUARANTINE_PREFIX = 'proton:verification:quarantine';

export const CAPTCHA_PREFIX = 'proton:verification:captcha';

export const PANEL_PREFIX = 'proton:verification:panel';

function read<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function quarantineKey(
  guildId: string,
  userId: string,
  prefix: string = QUARANTINE_PREFIX,
): string {
  return `${prefix}:${guildId}:${userId}`;
}

export const quarantineRecordSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  priorRoleIds: z.array(snowflakeSchema),

  quarantinedBy: snowflakeSchema,
  reason: z.string().max(512).nullable(),
  quarantinedAt: z.number().int().nonnegative(),
});

export type QuarantineRecord = z.infer<typeof quarantineRecordSchema>;

export interface QuarantineStore {
  get(guildId: string, userId: string): Promise<QuarantineRecord | null>;

  put(record: QuarantineRecord): Promise<void>;

  clear(guildId: string, userId: string): Promise<void>;
}

export class RedisQuarantineStore implements QuarantineStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { keyPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? QUARANTINE_PREFIX;
  }

  async get(guildId: string, userId: string): Promise<QuarantineRecord | null> {
    return read(
      await this.#redis.get(quarantineKey(guildId, userId, this.#prefix)),
      quarantineRecordSchema,
    );
  }

  async put(record: QuarantineRecord): Promise<void> {
    await this.#redis.set(
      quarantineKey(record.guildId, record.userId, this.#prefix),
      JSON.stringify(record),
    );
  }

  async clear(guildId: string, userId: string): Promise<void> {
    await this.#redis.del(quarantineKey(guildId, userId, this.#prefix));
  }
}

export function captchaKey(
  guildId: string,
  userId: string,
  prefix: string = CAPTCHA_PREFIX,
): string {
  return `${prefix}:${guildId}:${userId}`;
}

export const captchaChallengeSchema = z.object({
  challengeId: z.string().min(1).max(64),

  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  answer: z.string().min(1).max(16),
  attemptsUsed: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
});

export type CaptchaChallenge = z.infer<typeof captchaChallengeSchema>;

export interface CaptchaStore {
  get(guildId: string, userId: string): Promise<CaptchaChallenge | null>;

  put(challenge: CaptchaChallenge, ttlMs: number): Promise<void>;

  // Rewrites the record without extending it: a wrong answer must not buy the member more time.
  update(challenge: CaptchaChallenge): Promise<void>;

  clear(guildId: string, userId: string): Promise<void>;
}

export class RedisCaptchaStore implements CaptchaStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { keyPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? CAPTCHA_PREFIX;
  }

  async get(guildId: string, userId: string): Promise<CaptchaChallenge | null> {
    return read(
      await this.#redis.get(captchaKey(guildId, userId, this.#prefix)),
      captchaChallengeSchema,
    );
  }

  async put(challenge: CaptchaChallenge, ttlMs: number): Promise<void> {
    await this.#redis.set(
      captchaKey(challenge.guildId, challenge.userId, this.#prefix),
      JSON.stringify(challenge),
      'PX',
      Math.max(1, Math.floor(ttlMs)),
    );
  }

  // XX as well as KEEPTTL: the challenge can expire between the read and this write, and SET
  // KEEPTTL on a key that is gone recreates it with no expiry at all — an immortal captcha.
  async update(challenge: CaptchaChallenge): Promise<void> {
    await this.#redis.set(
      captchaKey(challenge.guildId, challenge.userId, this.#prefix),
      JSON.stringify(challenge),
      'KEEPTTL',
      'XX',
    );
  }

  async clear(guildId: string, userId: string): Promise<void> {
    await this.#redis.del(captchaKey(guildId, userId, this.#prefix));
  }
}

export function panelKey(guildId: string, prefix: string = PANEL_PREFIX): string {
  return `${prefix}:${guildId}`;
}

export const panelRecordSchema = z.object({
  guildId: snowflakeSchema,
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
  postedAt: z.number().int().nonnegative(),
});

export type PanelRecord = z.infer<typeof panelRecordSchema>;

export interface PanelStore {
  get(guildId: string): Promise<PanelRecord | null>;

  put(record: PanelRecord): Promise<void>;

  clear(guildId: string): Promise<void>;
}

export class RedisPanelStore implements PanelStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { keyPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? PANEL_PREFIX;
  }

  async get(guildId: string): Promise<PanelRecord | null> {
    return read(await this.#redis.get(panelKey(guildId, this.#prefix)), panelRecordSchema);
  }

  async put(record: PanelRecord): Promise<void> {
    await this.#redis.set(panelKey(record.guildId, this.#prefix), JSON.stringify(record));
  }

  async clear(guildId: string): Promise<void> {
    await this.#redis.del(panelKey(guildId, this.#prefix));
  }
}
