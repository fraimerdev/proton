import { formatDuration, snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const MAINTENANCE_PREFIX = 'proton:antinuke:maintenance';

export const MAINTENANCE_GRACE_MS = 5 * 60_000;

export function maintenanceKey(guildId: string, prefix: string = MAINTENANCE_PREFIX): string {
  return `${prefix}:${guildId}`;
}

export const maintenanceWindowSchema = z.object({
  guildId: snowflakeSchema,

  enabledBy: snowflakeSchema,
  reason: z.string().max(512).nullable(),
  startedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;

export interface MaintenanceStore {
  get(guildId: string): Promise<MaintenanceWindow | null>;
  set(window: MaintenanceWindow): Promise<void>;
  clear(guildId: string): Promise<void>;
}

export class RedisMaintenanceStore implements MaintenanceStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #now: () => number;

  constructor(redis: Redis, options: { keyPrefix?: string; now?: () => number } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? MAINTENANCE_PREFIX;
    this.#now = options.now ?? (() => Date.now());
  }

  async get(guildId: string): Promise<MaintenanceWindow | null> {
    const raw = await this.#redis.get(maintenanceKey(guildId, this.#prefix));
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const result = maintenanceWindowSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  async set(window: MaintenanceWindow): Promise<void> {
    const remaining = window.expiresAt - this.#now();

    if (remaining + MAINTENANCE_GRACE_MS <= 0) {
      await this.clear(window.guildId);
      return;
    }

    await this.#redis.set(
      maintenanceKey(window.guildId, this.#prefix),
      JSON.stringify(window),
      'PX',

      remaining + MAINTENANCE_GRACE_MS,
    );
  }

  async clear(guildId: string): Promise<void> {
    await this.#redis.del(maintenanceKey(guildId, this.#prefix));
  }
}

export function isCoveredByMaintenance(window: MaintenanceWindow, at: number): boolean {
  return at >= window.startedAt && at < window.expiresAt;
}

export function hasLapsed(window: MaintenanceWindow, now: number): boolean {
  return now >= window.expiresAt;
}

export interface MaintenancePlanInput {
  guildId: string;
  enabledBy: string;
  reason: string | null;
  durationMs: number;
  maxDurationMs: number;
  now: number;
}

export interface MaintenanceRefusal {
  refusal: string;
}

export function isMaintenanceRefusal(
  value: MaintenanceWindow | MaintenanceRefusal,
): value is MaintenanceRefusal {
  return 'refusal' in value;
}

export function planMaintenance(
  input: MaintenancePlanInput,
): MaintenanceWindow | MaintenanceRefusal {
  if (input.durationMs <= 0) {
    return {
      refusal:
        'Maintenance mode needs a positive duration — a window that expires immediately ' +
        'would leave the breaker armed for the work you are about to do.',
    };
  }

  if (input.durationMs > input.maxDurationMs) {
    return {
      refusal:
        `This server caps maintenance mode at ${formatDuration(input.maxDurationMs)}, and you ` +
        `asked for ${formatDuration(input.durationMs)}. Run it again for a shorter window, or ` +
        'raise "Longest maintenance window" in the Proton dashboard. The cap exists because ' +
        'maintenance mode switches off the only thing standing between a compromised admin ' +
        'and an empty server.',
    };
  }

  return {
    guildId: input.guildId,
    enabledBy: input.enabledBy,
    reason: input.reason,
    startedAt: input.now,
    expiresAt: input.now + input.durationMs,
  };
}
