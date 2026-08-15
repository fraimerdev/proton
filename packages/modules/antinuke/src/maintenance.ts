import { formatDuration, snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const MAINTENANCE_PREFIX = 'proton:antinuke:maintenance';

/**
 * How long the record outlives the window it describes.
 *
 * Deliberate. Audit-log entries for work done inside a maintenance window keep
 * arriving after it closes — delivery is eventually consistent (§15) — and
 * coverage is judged by when the act happened, so a record that vanished at the
 * stroke of expiry would let the tail of a legitimate bulk deletion trip the
 * breaker on the admin who was authorised to do it. The window itself is not
 * extended by one millisecond: an act performed after `expiresAt` is counted,
 * whether or not this record still exists.
 */
export const MAINTENANCE_GRACE_MS = 5 * 60_000;

export function maintenanceKey(guildId: string, prefix: string = MAINTENANCE_PREFIX): string {
  return `${prefix}:${guildId}`;
}

/**
 * A live maintenance window: the breaker is off for this guild until `expiresAt`.
 *
 * A Zod schema rather than an interface because this round-trips through Redis
 * as JSON, so by the time it is read back the type has been erased and the only
 * thing between a corrupt value and a disabled security control is a parse (the
 * I5 argument, applied to state rather than config).
 *
 * `expiresAt` is absolute rather than a duration, and nothing renews it. The
 * expiry is the whole feature: an admin who needs longer runs the command again,
 * which produces a second audit record, which is exactly the visibility a
 * silently-extended window would destroy.
 */
export const maintenanceWindowSchema = z.object({
  guildId: snowflakeSchema,
  /** The admin who ran `/antinuke maintenance`. Recorded so the audit names them. */
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

/**
 * Redis-backed maintenance windows.
 *
 * Redis rather than the module's config row for one reason: the key carries a
 * TTL, so the hole closes even if nothing ever reads it again. A timestamp in a
 * JSONB config column depends on every reader remembering to compare it against
 * the clock, and the one reader that forgets leaves the breaker off forever.
 */
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

    // Anything unreadable is treated as "no maintenance window", which leaves
    // the breaker armed. That is the only safe direction to fail in: the
    // alternative is a corrupt value that switches a security control off.
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
    // A window that ended before it was stored has nothing left to cover and no
    // lapse worth announcing.
    if (remaining + MAINTENANCE_GRACE_MS <= 0) {
      await this.clear(window.guildId);
      return;
    }

    await this.#redis.set(
      maintenanceKey(window.guildId, this.#prefix),
      JSON.stringify(window),
      'PX',
      // Redis closes the hole itself, so a worker that never reads this key
      // again cannot leave the breaker suppressed.
      remaining + MAINTENANCE_GRACE_MS,
    );
  }

  async clear(guildId: string): Promise<void> {
    await this.#redis.del(maintenanceKey(guildId, this.#prefix));
  }
}

/**
 * Whether an act performed at `at` happened while maintenance was on.
 *
 * Keyed on when the act happened, not on when we heard about it. Audit-log
 * delivery lags by seconds and is unordered (§15), so an entry for a legitimate
 * bulk deletion routinely arrives after the window that authorised it closed.
 * Judging it by arrival time would punish the admin for our own latency.
 */
export function isCoveredByMaintenance(window: MaintenanceWindow, at: number): boolean {
  return at >= window.startedAt && at < window.expiresAt;
}

/** Whether the window has run out, by the clock. Drives the re-arm announcement. */
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

/** A refusal an admin reads verbatim — never a silent no-op. */
export interface MaintenanceRefusal {
  refusal: string;
}

export function isMaintenanceRefusal(
  value: MaintenanceWindow | MaintenanceRefusal,
): value is MaintenanceRefusal {
  return 'refusal' in value;
}

/**
 * Turn a requested duration into a window, or refuse it.
 *
 * The cap is enforced here rather than at the schema so the refusal can name
 * both numbers: an admin who asks for 4 hours needs to be told the server's
 * limit is 1 hour, not that their input was invalid.
 */
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
