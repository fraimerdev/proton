import { snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const VOICE_SESSION_PREFIX = 'proton:leveling:voice';

/**
 * The longest stretch a single session is ever paid for.
 *
 * Two things need one number here. A session Proton somehow never saw close —
 * a gateway gap wider than RESUME can bridge, a guild going unavailable — must
 * not sit open and then pay out a week of "voice time" when the member finally
 * disconnects; and the Redis key holding it must expire on the same boundary, or
 * one of the two would be the real limit and the other a comment.
 * `RedisVoiceSessionStore` takes its default TTL from this constant for exactly
 * that reason.
 *
 * 24 hours is past any session worth paying for and past any outage worth
 * bridging.
 */
export const MAX_PAID_SESSION_MS = 24 * 60 * 60 * 1000;

export function voiceSessionKey(
  guildId: string,
  userId: string,
  prefix: string = VOICE_SESSION_PREFIX,
): string {
  return `${prefix}:${guildId}:${userId}`;
}

/**
 * An open voice session: **"in channel X since T"**, never "has accumulated N".
 *
 * That distinction is the entire restart story. An accumulator has to be written
 * on every tick and is wrong the moment a write is lost or repeated; a start
 * timestamp is written once, and re-applying the same VOICE_STATE_UPDATE — which
 * the normaliser's id derivation guarantees will happen, since a repeated
 * transition collapses onto one event id — writes the same value it already
 * held. A worker that restarts mid-session finds the session exactly as it left
 * it and pays for the real elapsed time; one that never restarts behaves
 * identically. Neither double-awards, and neither loses the session, which
 * PLAN.md §12 makes a Gate 3 criterion rather than a nicety.
 *
 * A Zod schema rather than an interface because it round-trips through Redis as
 * JSON, so by the time it is read back the type has been erased and the thing
 * being read is what decides how much XP somebody is owed.
 */
export const voiceSessionSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  channelId: snowflakeSchema,
  /** The `occurredAt` of the join event, in ms. Never a clock reading. */
  joinedAt: z.number().int().nonnegative(),
});

export type VoiceSession = z.infer<typeof voiceSessionSchema>;

/**
 * Where open voice sessions live.
 *
 * Redis, not Postgres: a session is ephemeral, hot, and worth nothing once it
 * has been paid out (docs/PHASE-3.md G7). The port is declared here for the same
 * reason `MemberXpStore` is — §7 hands a module no storage — but unlike that one
 * the implementation lives in this package (`redis-session-store.ts`), because
 * nothing outside leveling has any use for it.
 */
export interface VoiceSessionStore {
  /** The open session, or null. Read-only: does not extend or alter it. */
  get(guildId: string, userId: string): Promise<VoiceSession | null>;

  /**
   * Start a session. Overwrites any session already open for the member.
   *
   * Callers must close first if they intend to be paid for what was open — the
   * handler does exactly that on a channel move. Overwriting rather than
   * refusing keeps the store dumb: deciding whether a transition is a move, a
   * re-delivery or a fresh join is the handler's job, and splitting that
   * decision across two files is how the two end up disagreeing.
   */
  open(session: VoiceSession): Promise<void>;

  /**
   * Take the open session: read and delete in one atomic step.
   *
   * Atomicity is what makes a payout happen exactly once. Two deliveries of the
   * same disconnect both call this; only one of them gets the session back, and
   * the other sees null and pays nothing. A `get` followed by a `delete` would
   * pay twice, and the window is small enough that it would only ever happen in
   * production.
   */
  close(guildId: string, userId: string): Promise<VoiceSession | null>;
}
