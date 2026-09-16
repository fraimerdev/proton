import {
  type Attachment,
  type CommandContext,
  MESSAGE_CONTENT_MAX,
  type StatusBody,
} from '@proton/core';
import type { LevelingConfig } from './config.ts';

export const MODULE_ID = 'leveling';

export const LEVELING_ACTOR = 'proton:leveling';

export async function reply(
  ctx: CommandContext<LevelingConfig>,
  message: string | StatusBody,
  options: { ephemeral?: boolean; files?: Attachment[] } = {},
): Promise<void> {
  const body =
    typeof message === 'string'
      ? // Omitted rather than sent empty: /rank answers with the card alone, and Discord reads a
        // present-but-empty content as a caption to render rather than as no caption at all.
        message
        ? { content: message.slice(0, MESSAGE_CONTENT_MAX) }
        : {}
      : message;

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
      ...body,
      ephemeral: options.ephemeral ?? false,
      ...(options.files?.length ? { files: options.files } : {}),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `leveling could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
