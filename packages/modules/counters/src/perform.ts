import type { ActionResult, CommandContext, ModuleContext } from '@proton/core';
import { type CountersConfig, MODULE_ID } from './config.ts';
import type { CounterEdit } from './render.ts';

export const NOT_WIRED =
  "I can't refresh this server's counter channels because Proton isn't fully wired up in this " +
  'deployment. Nothing was renamed. The Proton logs name the exact missing piece.';

export const NO_STATE =
  "I don't have this server's channel list cached yet, so I can't tell which counters are " +
  'already showing the right number. Nothing was renamed — this clears itself the moment ' +
  'Proton finishes connecting to Discord.';

export async function reply(
  ctx: CommandContext<CountersConfig>,
  content: string,
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
      content: content.slice(0, 2000),
      ephemeral: true,
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `counters could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
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
    reason: 'counter channel refresh',
    idempotencyKey,
    dryRun: false,
    record: false,
    payload: { channelId: edit.channelId, name: edit.to },
  });
}
