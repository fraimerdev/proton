import { formatDuration } from '@proton/core';

/**
 * How much each signal is worth.
 *
 * Small integers rather than probabilities: an admin reading "scored 3 of 5" in
 * an alert can work out which signals fired from the sentences beside it, and a
 * confidence of 0.72 tells them nothing they can act on or argue with.
 *
 * The individual numbers matter less than one relationship between them —
 * `MIN_ACTIONABLE_SCORE` sits one above the heaviest single signal, so no score
 * threshold a guild is allowed to configure can let a single signal act on a
 * member. That is deliberate and it is the whole safety argument of this module:
 * a brand-new account with no avatar joining a server that is growing is an
 * ordinary Discord user, and locking them out is a worse outcome than letting
 * one raid account through. §15's framing — value is speed plus restore quality,
 * not perfect prevention — points the same way.
 */
export const SIGNAL_WEIGHTS = {
  /** The guild's join rate is at or above its configured threshold. */
  joinBurst: 2,
  /** The account is younger than `newAccountMs`. */
  newAccount: 1,
  /**
   * The account is younger than `brandNewAccountMs`.
   *
   * Graded, not additive: it replaces `newAccount` rather than stacking with it.
   * Stacking would make account age alone worth 3, which is exactly the "one
   * signal acted on a real user" outcome the threshold floor exists to prevent.
   */
  brandNewAccount: 2,
  /** The account has no avatar — neither a global one nor a per-guild one. */
  avatarless: 1,
} as const;

/** The heaviest any one signal can be. Kept derived so it cannot drift. */
export const MAX_SINGLE_SIGNAL_WEIGHT = Math.max(
  SIGNAL_WEIGHTS.joinBurst,
  SIGNAL_WEIGHTS.brandNewAccount,
  SIGNAL_WEIGHTS.avatarless,
);

/**
 * The lowest score threshold a guild may configure.
 *
 * One above the heaviest single signal, so acting always takes at least two
 * independent signals. `antiraidConfigSchema` uses it as the minimum, which makes
 * the rule a schema constraint an admin cannot opt out of rather than a comment
 * someone later lowers "just for a raid".
 */
export const MIN_ACTIONABLE_SCORE = MAX_SINGLE_SIGNAL_WEIGHT + 1;

/** Everything firing at once. The ceiling of the configurable threshold. */
export const MAX_JOIN_SCORE =
  SIGNAL_WEIGHTS.joinBurst + SIGNAL_WEIGHTS.brandNewAccount + SIGNAL_WEIGHTS.avatarless;

export interface JoinSignals {
  /**
   * How long the account had existed at the moment it joined, in ms. Null when
   * the user id could not be read as a snowflake, which scores nothing rather
   * than scoring as suspicious — an unreadable fact is not evidence.
   */
  accountAgeMs: number | null;
  /** Null when the dispatch carried no user object to read an avatar from. */
  avatarless: boolean | null;
  /** Joins inside the window, this one included, as the rate window counted them. */
  joinsInWindow: number;
}

export interface ScoreSettings {
  /** Joins inside the window at or above which the guild counts as under a burst. */
  joinThreshold: number;
  /** The window as authored, e.g. `'10s'`. Used only to write the sentence. */
  joinWindow: string;
  newAccountMs: number;
  brandNewAccountMs: number;
}

export interface RaidScore {
  score: number;
  /** Whether the guild's join rate is over threshold as of this join. */
  burst: boolean;
  /**
   * One sentence per signal, in the order they were weighed.
   *
   * These are the module's entire explanation of itself: they become the alert
   * body and the Discord audit-log reason attached to the action, so a member
   * who was quarantined can be told why and a staff member can disagree with it.
   */
  reasons: string[];
}

/**
 * Weigh one join.
 *
 * Pure and synchronous — no Redis, no clock, no Discord — so the combination
 * rules are exhaustively testable, which is the only way to have any confidence
 * in a heuristic that kicks people.
 */
export function scoreJoin(signals: JoinSignals, settings: ScoreSettings): RaidScore {
  const reasons: string[] = [];
  let score = 0;

  const burst = signals.joinsInWindow >= settings.joinThreshold;
  if (burst) {
    score += SIGNAL_WEIGHTS.joinBurst;
    reasons.push(
      `${signals.joinsInWindow} accounts joined within ${settings.joinWindow}, at or above this ` +
        `server's threshold of ${settings.joinThreshold}.`,
    );
  }

  if (signals.accountAgeMs === null) {
    // Never silently: a fact that could not be read is a different thing from a
    // fact that was read and did not match, and only one of them is a bug.
    reasons.push('The account age could not be read from the user id, so it was not weighed.');
  } else if (signals.accountAgeMs < settings.brandNewAccountMs) {
    score += SIGNAL_WEIGHTS.brandNewAccount;
    reasons.push(
      `The account was created ${formatDuration(signals.accountAgeMs)} before joining, under ` +
        `the ${formatDuration(settings.brandNewAccountMs)} this server treats as brand new.`,
    );
  } else if (signals.accountAgeMs < settings.newAccountMs) {
    score += SIGNAL_WEIGHTS.newAccount;
    reasons.push(
      `The account was created ${formatDuration(signals.accountAgeMs)} before joining, under ` +
        `the ${formatDuration(settings.newAccountMs)} this server treats as new.`,
    );
  }

  if (signals.avatarless === null) {
    reasons.push('The join carried no user object, so the avatar was not weighed.');
  } else if (signals.avatarless) {
    score += SIGNAL_WEIGHTS.avatarless;
    reasons.push('The account has no avatar.');
  }

  return { score, burst, reasons };
}
