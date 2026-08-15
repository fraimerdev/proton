import type { CommandContext } from '@proton/core';
import type { LevelingConfig } from './config.ts';

export const MODULE_ID = 'leveling';

export const LEVELING_ACTOR = 'proton:leveling';

export async function reply(
  ctx: CommandContext<LevelingConfig>,
  content: string,
  options: { ephemeral?: boolean } = {},
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

      content: content.slice(0, 2000),
      ephemeral: options.ephemeral ?? false,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `leveling could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
