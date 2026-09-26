import { type EncodeCustomIdResult, encodeCustomId, snowflakeCreatedAt } from '@proton/core';
import { ACHIEVEMENT_ID, MODULE_ID } from './config.ts';
import type { AchievementLimits } from './deps.ts';

export const RESET_ACTION = 'rs';
export const RESET_CANCEL_ACTION = 'rsx';

export const RESET_DRAFT_TTL_MS = 15 * 60 * 1000;

export const RESET_DRAFT_PREFIX = 'proton:achievements:reset';

export type ResetStep = 1 | 2;

export interface ResetDraft {
  draftId: string;
  memberId: string;
  achievementId: string | null;
  rewardsAgain: boolean;
}

const SNOWFLAKE = /^\d{17,20}$/;
const DRAFT_ID = /^[0-9a-z]{1,16}$/;

export function draftIdOf(interactionId: string): string | null {
  return SNOWFLAKE.test(interactionId) ? BigInt(interactionId).toString(36) : null;
}

export function interactionIdOf(draftId: string): string | null {
  if (!DRAFT_ID.test(draftId)) return null;

  let value = 0n;
  for (const digit of draftId) value = value * 36n + BigInt(Number.parseInt(digit, 36));

  const id = value.toString();
  return SNOWFLAKE.test(id) ? id : null;
}

export function draftExpired(draftId: string, now: number): boolean {
  const interactionId = interactionIdOf(draftId);
  const createdAt = interactionId === null ? null : snowflakeCreatedAt(interactionId);
  return createdAt === null || now - createdAt > RESET_DRAFT_TTL_MS;
}

export function resetButtonId(draft: ResetDraft, step: ResetStep): EncodeCustomIdResult {
  return encodeCustomId(
    MODULE_ID,
    RESET_ACTION,
    draft.draftId,
    String(step),
    draft.memberId,
    draft.achievementId ?? '',
    draft.rewardsAgain ? '1' : '0',
  );
}

export function cancelButtonId(draft: ResetDraft, step: ResetStep): EncodeCustomIdResult {
  return encodeCustomId(MODULE_ID, RESET_CANCEL_ACTION, draft.draftId, String(step));
}

function stepOf(raw: string | undefined): ResetStep | null {
  return raw === '1' ? 1 : raw === '2' ? 2 : null;
}

export function readResetArgs(
  args: readonly string[],
): { draft: ResetDraft; step: ResetStep } | null {
  const [draftId, rawStep, memberId, achievementId, again] = args;
  const step = stepOf(rawStep);

  if (
    draftId === undefined ||
    !DRAFT_ID.test(draftId) ||
    step === null ||
    memberId === undefined ||
    !SNOWFLAKE.test(memberId) ||
    achievementId === undefined ||
    (achievementId !== '' && !ACHIEVEMENT_ID.test(achievementId)) ||
    (again !== '0' && again !== '1')
  ) {
    return null;
  }

  return {
    draft: {
      draftId,
      memberId,
      achievementId: achievementId === '' ? null : achievementId,
      rewardsAgain: again === '1',
    },
    step,
  };
}

export function readCancelArgs(
  args: readonly string[],
): { draftId: string; step: ResetStep } | null {
  const [draftId, rawStep] = args;
  const step = stepOf(rawStep);
  if (draftId === undefined || !DRAFT_ID.test(draftId) || step === null) return null;

  return { draftId, step };
}

function draftKey(guildId: string, draftId: string, step: ResetStep): string {
  return `${RESET_DRAFT_PREFIX}:${guildId}:${draftId}:${step}`;
}

export function spendDraft(
  limits: AchievementLimits,
  guildId: string,
  draftId: string,
  step: ResetStep,
  spentBy: string,
): Promise<boolean> {
  // The press id, never a constant: claim re-enters on an equal value, so a constant passes every press.
  return limits.claim(draftKey(guildId, draftId, step), spentBy, RESET_DRAFT_TTL_MS);
}

export async function releaseDraft(
  limits: AchievementLimits,
  guildId: string,
  draftId: string,
  step: ResetStep,
  spentBy: string,
): Promise<void> {
  await limits.release(draftKey(guildId, draftId, step), spentBy);
}
