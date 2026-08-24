import { newCaptchaAnswer } from '@proton/cards';
import { newId, tryParseDuration } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import type { CaptchaChallenge } from './store.ts';

export const CAPTCHA_FALLBACK_TTL_MS = 5 * 60 * 1000;

export function newChallenge(
  guildId: string,
  userId: string,
  length: number,
  now: number,
  attemptsUsed = 0,
): CaptchaChallenge {
  return {
    challengeId: newId(),
    guildId,
    userId,
    answer: newCaptchaAnswer(length),
    attemptsUsed,
    issuedAt: now,
  };
}

export function challengeTtlMs(config: VerificationConfig): number {
  const ms = tryParseDuration(config.captchaExpiry);

  return ms === null || ms <= 0 ? CAPTCHA_FALLBACK_TTL_MS : ms;
}

export function answerMatches(challenge: CaptchaChallenge, submitted: string): boolean {
  return normalise(submitted) === normalise(challenge.answer);
}

function normalise(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}
