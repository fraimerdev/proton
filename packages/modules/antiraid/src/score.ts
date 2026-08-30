import { formatDuration } from '@proton/core';

export const SIGNAL_WEIGHTS = {
  joinBurst: 2,

  newAccount: 1,

  brandNewAccount: 2,

  avatarless: 1,
} as const;

export const MAX_SINGLE_SIGNAL_WEIGHT = Math.max(
  SIGNAL_WEIGHTS.joinBurst,
  SIGNAL_WEIGHTS.brandNewAccount,
  SIGNAL_WEIGHTS.avatarless,
);

export const MIN_ACTIONABLE_SCORE = MAX_SINGLE_SIGNAL_WEIGHT + 1;

export const MAX_JOIN_SCORE =
  SIGNAL_WEIGHTS.joinBurst + SIGNAL_WEIGHTS.brandNewAccount + SIGNAL_WEIGHTS.avatarless;

export interface JoinSignals {
  accountAgeMs: number | null;

  avatarless: boolean | null;

  joinsInWindow: number;
}

export interface ScoreSettings {
  joinThreshold: number;

  joinWindow: string;
  newAccountMs: number;
  brandNewAccountMs: number;
}

export interface RaidScore {
  score: number;

  burst: boolean;

  reasons: string[];
}

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
    reasons.push('The join carried no profile details, so the avatar was not weighed.');
  } else if (signals.avatarless) {
    score += SIGNAL_WEIGHTS.avatarless;
    reasons.push('The account has no avatar.');
  }

  return { score, burst, reasons };
}
