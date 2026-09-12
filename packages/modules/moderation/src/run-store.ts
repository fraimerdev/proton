import { snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const ROLE_RUN_PREFIX = 'proton:moderation:rolerun';

// A run that outlives this has stalled, and holding the one-run-per-guild slot for a job that is
// never coming back would lock /role all out of the server for good.
export const ROLE_RUN_TTL_SECONDS = 24 * 60 * 60;

export const ROLE_RUN_MODES = ['all', 'bots', 'humans', 'in'] as const;

export type RoleRunMode = (typeof ROLE_RUN_MODES)[number];

export const ROLE_RUN_MODE_LABELS: Record<RoleRunMode, string> = {
  all: 'every member',
  bots: 'every bot',
  humans: 'every member except bots',
  in: 'every member holding a role',
};

export const roleRunSchema = z.object({
  runId: z.string().min(1).max(64),
  guildId: snowflakeSchema,

  roleId: snowflakeSchema,
  mode: z.enum(ROLE_RUN_MODES),
  targetRoleId: snowflakeSchema.optional(),

  actorId: snowflakeSchema,

  // Snapshotted, not re-read: the run re-checks every tick that the invoker still outranks what
  // it is handing out, and their own roles can change while it walks the member list.
  actorRoleIds: z.array(snowflakeSchema).default([]),

  channelId: snowflakeSchema,
  messageId: snowflakeSchema.optional(),
  reason: z.string().max(512).optional(),

  // Discord's member cursor, not a count — '0' is the start, and it is a snowflake thereafter.
  after: z.string(),

  scanned: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),

  // Consecutive, and reset by any page that comes back — a run is abandoned only when the member
  // list stays unreadable, never on the first blip.
  listFailures: z.number().int().nonnegative().default(0),

  approximateTotal: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative(),
  cancelled: z.boolean(),
});

export type RoleRun = z.infer<typeof roleRunSchema>;

export interface RoleRunStore {
  get(guildId: string): Promise<RoleRun | null>;
  put(run: RoleRun): Promise<void>;
  clear(guildId: string): Promise<void>;
}

export function roleRunKey(guildId: string, prefix: string = ROLE_RUN_PREFIX): string {
  return `${prefix}:${guildId}`;
}

export class RedisRoleRunStore implements RoleRunStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttl: number;

  constructor(redis: Redis, options: { keyPrefix?: string; ttlSeconds?: number } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? ROLE_RUN_PREFIX;
    this.#ttl = options.ttlSeconds ?? ROLE_RUN_TTL_SECONDS;
  }

  async get(guildId: string): Promise<RoleRun | null> {
    const raw = await this.#redis.get(roleRunKey(guildId, this.#prefix));
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const result = roleRunSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  async put(run: RoleRun): Promise<void> {
    await this.#redis.set(
      roleRunKey(run.guildId, this.#prefix),
      JSON.stringify(run),
      'EX',
      this.#ttl,
    );
  }

  async clear(guildId: string): Promise<void> {
    await this.#redis.del(roleRunKey(guildId, this.#prefix));
  }
}
