import { type ActionResult, type ModuleContext, snowflakeSchema } from '@proton/core';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
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

// Discord 404s an unban for somebody no longer banned, which is the state accepting asked for.
function alreadyUnbanned(panel: AppealPanel, result: ActionResult): boolean {
  if (panel.onApprove !== 'unban' || result.failure?.code !== 'discord_404') return false;

  const discordCode = result.failure.discordCode;
  return discordCode === undefined || discordCode === RESTJSONErrorCodes.UnknownBan;
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

  const decider = snowflakeSchema.safeParse(appeal.decidedBy);

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: panel.onApprove,
    actorId: decider.success ? decider.data : APPEALS_ACTOR,
    targetId: appeal.userId,
    reason: `Appeal #${appeal.number} was accepted.`,
    payload: { userId: appeal.userId },
    dryRun: false,
    idempotencyKey: `${MODULE_ID}:${appeal.id}:${panel.onApprove}`,
  });

  if (alreadyUnbanned(panel, result)) {
    ctx.logger.info(
      `appeal #${appeal.number} was accepted and ${appeal.userId} was no longer banned, so there ` +
        'was no ban left to lift.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: appeal.userId },
    );
  } else if (!succeeded(result)) {
    const humanReason = result.failure?.humanReason ?? 'Discord gave no reason.';

    const unban = panel.onApprove === 'unban';

    ctx.logger.error(
      `appeal #${appeal.number} was accepted but ${appeal.userId} could NOT be ` +
        `${unban ? 'unbanned' : 'untimed out'}: ${humanReason} A moderator has to lift the ` +
        `${unban ? 'ban' : 'timeout'} by hand if it is still in place.`,
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
    idempotencyKey:
      `${MODULE_ID}:${appeal.id}:card:${fresh.status}:` +
      (fresh.outcomeApplied ? 'applied' : 'pending'),
    payload: {
      channelId: appeal.cardChannelId,
      messageId: appeal.cardMessageId,
      components: built.components,
    },
  });
}
