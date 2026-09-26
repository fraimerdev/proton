import {
  type ActionResult,
  type Attachment,
  type CommandContext,
  defer,
  followUp,
  MESSAGE_CONTENT_MAX,
  type RespondTo,
  type StatusBody,
} from '@proton/core';
import type { LevelingConfig } from './config.ts';
import type { LevelingDeps } from './deps.ts';

export const MODULE_ID = 'leveling';

export const LEVELING_ACTOR = 'proton:leveling';

type Ctx = CommandContext<LevelingConfig>;

function bodyOf(message: string | StatusBody): { content?: string } | StatusBody {
  if (typeof message !== 'string') return message;

  // Omitted rather than sent empty: /rank answers with the card alone, and Discord reads a
  // present-but-empty content as a caption to render rather than as no caption at all.
  return message ? { content: message.slice(0, MESSAGE_CONTENT_MAX) } : {};
}

function warnUnanswered(ctx: Ctx, result: ActionResult): void {
  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `leveling could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

export async function reply(
  ctx: Ctx,
  message: string | StatusBody,
  options: { ephemeral?: boolean; files?: Attachment[] } = {},
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,

    idempotencyKey: `${ctx.idempotencyKey}:reply`,

    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      ...bodyOf(message),
      ephemeral: options.ephemeral ?? false,
      ...(options.files?.length ? { files: options.files } : {}),
    },
  });

  warnUnanswered(ctx, result);
}

export type Answer = (message: string | StatusBody, files?: Attachment[]) => Promise<void>;

export async function acknowledge(
  ctx: Ctx,
  deps: LevelingDeps,
  ephemeral: boolean,
): Promise<Answer> {
  const applicationId = ctx.applicationId ?? deps.applicationId;
  if (!applicationId) {
    return (message, files = []) => reply(ctx, message, { ephemeral, files });
  }

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: { id: ctx.interaction.id, token: ctx.interaction.token },
    idempotencyKey: ctx.idempotencyKey,
  };
  warnUnanswered(ctx, await ctx.executor.execute(defer(to, { ephemeral })));

  return async (message, files = []) =>
    warnUnanswered(
      ctx,
      await ctx.executor.execute(
        followUp(
          { ...to, applicationId },
          { ...bodyOf(message), ...(files.length > 0 ? { files } : {}), ephemeral },
        ),
      ),
    );
}
