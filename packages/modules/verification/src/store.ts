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

/**
 * What a member held before they were quarantined.
 *
 * A Zod schema rather than an interface because this round-trips through Redis
 * as JSON, so by the time it is read back the type has been erased — and the
 * thing being read back is the *only* description of how to put a member's
 * server access back. A half-parsed record restoring four of seven roles is
 * worse than no record, because it looks like it worked (the I5 argument,
 * applied to state rather than config).
 *
 * `priorRoleIds` may legitimately be empty: a member who held nothing but
 * `@everyone` has an exact restoration too, and it is "give back nothing". That
 * is why the store distinguishes an empty record from a missing one — see
 * `QuarantineStore.get`.
 */
export const quarantineRecordSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  /**
   * Every role removed, in the order they were removed (highest position first).
   * Never contains `@everyone` or the quarantine role — neither is restorable
   * and neither was taken away.
   */
  priorRoleIds: z.array(snowflakeSchema),
  /** The moderator who ran `/quarantine`, so the record names a person. */
  quarantinedBy: snowflakeSchema,
  reason: z.string().max(512).nullable(),
  quarantinedAt: z.number().int().nonnegative(),
});

export type QuarantineRecord = z.infer<typeof quarantineRecordSchema>;

/**
 * Where the prior-role record lives.
 *
 * A port declared by the module rather than by `packages/core`, because §7 gives
 * a module its own storage in principle but `ModuleContext` carries a config, an
 * executor and a logger and nothing else — the same gap `createLoggingModule`
 * works around with its message-log store and `createAntinukeModule` with its
 * maintenance store.
 */
export interface QuarantineStore {
  /** The live record, or null when the member is not quarantined. */
  get(guildId: string, userId: string): Promise<QuarantineRecord | null>;
  /**
   * Write the record. Called *before* the first role is removed, so a crash
   * midway through leaves a member who can still be restored exactly.
   */
  put(record: QuarantineRecord): Promise<void>;
  /** Drop the record. Called only once every role has actually gone back. */
  clear(guildId: string, userId: string): Promise<void>;
}

/**
 * Redis-backed quarantine records.
 *
 * **Deliberately no TTL.** Every other Redis key in Proton expires because the
 * thing it describes expires — a dedupe claim, a rate window, a maintenance
 * hole. A quarantine does not: it lasts until a moderator lifts it, which may be
 * next week. A key that expired first would leave a member wearing the
 * quarantine role with nothing left that knows what to give back, and Proton
 * would have to guess. Lockdown refuses to guess at a channel's previous
 * overwrites for the same reason (R4).
 *
 * The record is also written into the payload of every `remove_role` action, so
 * the case ledger holds a second, durable copy that a human can read if Redis is
 * lost. That copy is not machine-restorable today — `ModuleContext` has no way
 * to query cases — which is recorded as a blocker on `createVerificationModule`.
 */
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
