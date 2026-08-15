import { snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const QUARANTINE_PREFIX = 'proton:verification:quarantine';

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
    const raw = await this.#redis.get(quarantineKey(guildId, userId, this.#prefix));
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const result = quarantineRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
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
