import {
  type AllowedMentions,
  type CommandContext,
  MESSAGE_CONTENT_MAX,
  type StatusBody,
} from '@proton/core';
import { MODULE_ID, type RemindersConfig } from './config.ts';

export const MENTIONS_OFF: AllowedMentions = { parse: [] };

export function mentionOnly(userId: string): AllowedMentions {
  return { parse: [], users: [userId] };
}

export interface ReplyOptions {
  ephemeral?: boolean;
  allowedMentions?: AllowedMentions;

  suffix?: string;
}

export async function reply(
  ctx: CommandContext<RemindersConfig>,
  message: string | StatusBody,
  options: ReplyOptions = {},
): Promise<void> {
  const body =
    typeof message === 'string' ? { content: message.slice(0, MESSAGE_CONTENT_MAX) } : message;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:${options.suffix ?? 'reply'}`,
    dryRun: false,
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      ...body,
      ephemeral: options.ephemeral ?? true,
      ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `reminders could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
