import {
  type ActionResult,
  type AllowedMentions,
  type CommandContext,
  deferEphemeral,
  followUp,
  type ModuleContext,
  type RespondTo,
  replyEphemeral,
} from '@proton/core';
import { MODULE_ID, type PollsConfig } from './config.ts';

// A poll question and its answers are member-authored text that /poll list and the closing note
// both quote back, so a poll called "@everyone" must not become a button anyone can press.
export const MENTIONS_OFF: AllowedMentions = { parse: [] };

type Ctx = CommandContext<PollsConfig>;

function respondTo(ctx: Ctx): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: { id: ctx.interaction.id, token: ctx.interaction.token },
    idempotencyKey: ctx.idempotencyKey,
  };
}

function report(ctx: ModuleContext<PollsConfig>, attempt: string, result: ActionResult): void {
  if (result.status !== 'failed_precheck' && result.status !== 'failed_api') return;

  ctx.logger.warn(
    `polls could not ${attempt}: ${result.failure?.humanReason ?? 'no reason was reported'}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
  );
}

export async function acknowledge(ctx: Ctx): Promise<void> {
  report(
    ctx,
    'acknowledge the command',
    await ctx.executor.execute(deferEphemeral(respondTo(ctx))),
  );
}

export async function answer(ctx: Ctx, applicationId: string, content: string): Promise<void> {
  const result = await ctx.executor.execute(
    followUp(
      { ...respondTo(ctx), applicationId },
      { content, ephemeral: true, allowedMentions: MENTIONS_OFF },
    ),
  );

  report(ctx, 'answer the command', result);
}

export async function replyNow(ctx: Ctx, content: string): Promise<void> {
  const result = await ctx.executor.execute(
    replyEphemeral(respondTo(ctx), { content, allowedMentions: MENTIONS_OFF }),
  );

  report(ctx, 'answer the command', result);
}
