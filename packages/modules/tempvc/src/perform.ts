import type { CommandContext, StatusBody } from '@proton/core';
import { MODULE_ID, type TempVcConfig } from './config.ts';

export async function reply(
  ctx: CommandContext<TempVcConfig>,
  message: string | StatusBody,
  suffix = 'reply',
): Promise<void> {
  const body = typeof message === 'string' ? { content: message.slice(0, 2000) } : message;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:${suffix}`,
    dryRun: false,
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      ...body,
      ephemeral: true,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `tempvc could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
