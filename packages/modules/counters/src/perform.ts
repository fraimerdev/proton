import {
  type ActionResult,
  type CommandContext,
  deferEphemeral,
  followUp,
  MESSAGE_CONTENT_MAX,
  type ModuleContext,
  type RespondTo,
  type StatusBody,
} from '@proton/core';
import { type CountersConfig, MODULE_ID } from './config.ts';
import type { CounterEdit } from './render.ts';

export const NOT_WIRED =
  'I can’t refresh this server’s counter channels right now. Nothing was renamed. This is a fault ' +
  'on my side, not a setting in this server.';

export const NO_STATE =
  "I'm still loading this server's channels, so nothing was renamed. Try again in a minute.";

export const NO_STORE =
  'I can’t keep track of new counter channels right now. Counters that use a channel you chose ' +
  'still refresh. This is a fault on my side, not a setting in this server.';

type Ctx = CommandContext<CountersConfig>;

export type Answer = (message: string | StatusBody) => Promise<void>;

function bodyOf(message: string | StatusBody): { content: string } | StatusBody {
  return typeof message === 'string' ? { content: message.slice(0, MESSAGE_CONTENT_MAX) } : message;
}

function warnUnanswered(ctx: Ctx, result: ActionResult): void {
  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `counters could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

export async function reply(
  ctx: Ctx,
  message: string | StatusBody,
  suffix = 'reply',
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:${suffix}`,
    dryRun: false,
    // Renaming a counter is not a moderation action; recording it would fill the case ledger.
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      ...bodyOf(message),
      ephemeral: true,
      allowedMentions: { parse: [] },
    },
  });

  warnUnanswered(ctx, result);
}

export async function acknowledge(ctx: Ctx): Promise<Answer> {
  const applicationId = ctx.applicationId;
  // Without an application id there is no followup webhook, so the one callback must be the answer.
  if (!applicationId) return (message) => reply(ctx, message);

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: ctx.idempotencyKey,
  };

  warnUnanswered(ctx, await ctx.executor.execute(deferEphemeral(to)));

  return async (message) =>
    warnUnanswered(
      ctx,
      await ctx.executor.execute(
        followUp(
          { ...to, applicationId },
          { ...bodyOf(message), ephemeral: true, allowedMentions: { parse: [] } },
        ),
      ),
    );
}

export async function renameChannel(
  ctx: ModuleContext<CountersConfig>,
  edit: CounterEdit,
  idempotencyKey: string,
): Promise<ActionResult> {
  return ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: MODULE_ID,
    reason: 'Counter channel refresh',
    idempotencyKey,
    dryRun: false,
    record: false,
    payload: { channelId: edit.channelId, name: edit.to },
  });
}
