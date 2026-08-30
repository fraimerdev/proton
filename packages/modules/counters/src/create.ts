import type { ActionResult, ModuleContext } from '@proton/core';
import { Permissions } from '@proton/core';
import { type CountersConfig, MODULE_ID } from './config.ts';

export const VOICE_CHANNEL_TYPE = 2;

const ROLE_OVERWRITE = 0;

export const LOST_CREATE =
  'I already made a channel for this counter but could not record which one it was, so I have ' +
  'not made another — a second would be renamed in turn and neither would settle. Look at the ' +
  'top of your channel list: if a stray counter channel is sitting there, delete it. Then remove ' +
  'this counter and add it again, which is what lets me start over.';

export const NO_CHANNEL_ID =
  'Discord accepted the channel but did not say which one it made, so there is nothing for me ' +
  'to rename later. Nothing else was changed.';

export type CreateOutcome = { created: string; locked: boolean } | { refused: string };

function describe(result: ActionResult): string {
  if (result.status === 'skipped_duplicate') return LOST_CREATE;
  return result.failure?.humanReason ?? `the action ended as ${result.status}.`;
}

export async function createCounterChannel(
  ctx: ModuleContext<CountersConfig>,
  counterId: string,
  name: string,
): Promise<CreateOutcome> {
  const created = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_channel',
    actorId: MODULE_ID,
    reason: 'counter channel',
    // Stable per counter rather than per refresh: the executor releases the claim whenever Discord
    // refuses, so a failed create is retried on the next pass while a redelivered one is not made
    // a second time.
    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${counterId}:create`,
    dryRun: false,
    record: false,
    payload: {
      name,
      type: VOICE_CHANNEL_TYPE,
      // Where server-stat channels belong, and where Discord puts a channel with no category.
      position: 0,
    },
  });

  if (created.status !== 'executed') return { refused: describe(created) };

  const channelId = (created.body as { id?: unknown } | undefined)?.id;
  if (typeof channelId !== 'string') return { refused: NO_CHANNEL_ID };

  return { created: channelId, locked: await lock(ctx, channelId) };
}

async function lock(ctx: ModuleContext<CountersConfig>, channelId: string): Promise<boolean> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_channel_overwrite',
    actorId: MODULE_ID,
    reason: 'a counter channel is for reading, not for joining',
    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${channelId}:lock`,
    dryRun: false,
    record: false,
    payload: {
      channelId,
      // Discord defines @everyone's role id as the guild id.
      overwriteId: ctx.guildId,
      type: ROLE_OVERWRITE,
      deny: String(Permissions.Connect),
    },
  });

  return result.status === 'executed' || result.status === 'skipped_duplicate';
}
