import type { ActionResult, ModuleContext } from '@proton/core';
import { APPEALS_ACTOR, type AppealPanel, type AppealsConfig, MODULE_ID } from './config.ts';
import type { AppealsDeps } from './deps.ts';
import { buildReviewCard } from './review.ts';
import type { AppealRecord, AppealStore } from './store.ts';

function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export interface ApplyOutcome {
  lifted: boolean;
  unblocked: boolean;
  humanReason: string | null;
}

/**
 * Every effect is keyed off the appeal id and safe to repeat, which is what lets a moderator press
 * the button again after a crash between the decision being recorded and it being carried out.
 */
export async function applyDecision(
  ctx: ModuleContext<AppealsConfig>,
  deps: AppealsDeps,
  appeal: AppealRecord,
  panel: AppealPanel,
): Promise<ApplyOutcome> {
  if (appeal.status !== 'approved' || panel.onApprove === 'nothing') {
    return { lifted: false, unblocked: false, humanReason: null };
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: panel.onApprove,
    actorId: APPEALS_ACTOR,
    targetId: appeal.userId,
    reason: `Appeal #${appeal.number} was accepted.`,
    payload: { userId: appeal.userId },
    dryRun: false,
    idempotencyKey: `${MODULE_ID}:${appeal.id}:${panel.onApprove}`,
  });

  if (!succeeded(result)) {
    const humanReason = result.failure?.humanReason ?? 'Discord gave no reason.';

    ctx.logger.error(
      `appeal #${appeal.number} was accepted but ${appeal.userId} could NOT be ` +
        `${panel.onApprove === 'unban' ? 'unbanned' : 'untimed out'}: ${humanReason}. A ` +
        'moderator has to do it by hand, or press Accept again.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: appeal.userId },
    );

    return { lifted: false, unblocked: false, humanReason };
  }

  let unblocked = false;

  if (panel.liftBlocklistOnApprove && deps.blocked) {
    try {
      const { lifted } = await deps.blocked.lift({
        guildId: ctx.guildId,
        userId: appeal.userId,
        liftedBy: appeal.decidedBy ?? APPEALS_ACTOR,
        liftReason: `Appeal #${appeal.number} was accepted.`,
      });

      unblocked = lifted;
    } catch (error) {
      ctx.logger.error(
        `appeal #${appeal.number} was accepted but ${appeal.userId} could not be taken off the ` +
          `blocked list: ${error instanceof Error ? error.message : String(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId: appeal.userId },
      );
    }
  }

  return { lifted: true, unblocked, humanReason: null };
}

// Stamped last, on purpose. A half-finished decision keeps its live buttons, so a moderator can
// see it did not complete and press again.
export async function stampCard(
  ctx: ModuleContext<AppealsConfig>,
  store: AppealStore,
  appeal: AppealRecord,
  panel: AppealPanel,
): Promise<void> {
  if (!appeal.cardChannelId || !appeal.cardMessageId) return;

  const fresh = (await store.find(ctx.guildId, appeal.id)) ?? appeal;
  const built = buildReviewCard(fresh, panel);
  if (!built.ok) return;

  await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: APPEALS_ACTOR,
    dryRun: false,
    record: false,
    idempotencyKey: `${MODULE_ID}:${appeal.id}:card:${fresh.status}`,
    payload: {
      channelId: appeal.cardChannelId,
      messageId: appeal.cardMessageId,
      components: built.components,
    },
  });
}
