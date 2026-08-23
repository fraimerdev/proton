import type { AllowedMentions, CommandContext } from '@proton/core';
import { MODULE_ID, type TagsConfig } from './config.ts';

// { parse: [] } still renders <@id> as a link, it just does not notify — which is what a stored
// snippet recalled by anyone should do.
export const MENTIONS_OFF: AllowedMentions = { parse: [] };

export interface ReplyOptions {
  ephemeral?: boolean;
  allowedMentions?: AllowedMentions;

  suffix?: string;
}

export async function reply(
  ctx: CommandContext<TagsConfig>,
  content: string,
  options: ReplyOptions = {},
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:${options.suffix ?? 'reply'}`,
    dryRun: false,
    // A tag is not a moderation action; recording one would put every /tag in the case ledger.
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content: content.slice(0, 2000),
      ephemeral: options.ephemeral ?? false,
      ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `tags could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
