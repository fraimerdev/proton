import type { ModuleContext } from '@proton/core';
import type { LevelingConfig } from './config.ts';
import type { LevelingDeps } from './deps.ts';
import { channelChain } from './multipliers.ts';
import { MODULE_ID } from './perform.ts';
import type { XpEvent } from './xp-events.ts';

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function channelChainFor(
  ctx: ModuleContext<LevelingConfig>,
  deps: LevelingDeps,
  guildId: string,
  channelId: string,
): Promise<string[]> {
  if (ctx.config.channelMultipliers.length === 0 || !deps.guildState) return [channelId];

  try {
    return channelChain(channelId, (await deps.guildState.get(guildId))?.channels);
  } catch (error) {
    ctx.logger.warn(
      `leveling could not read the channels of server ${guildId}, so only a multiplier set on ` +
        `<#${channelId}> itself applied — not one on its parent channel or category: ${reason(error)}`,
      { guildId, moduleId: MODULE_ID, channelId },
    );
    return [channelId];
  }
}

export async function xpEventsBetween(
  ctx: ModuleContext<LevelingConfig>,
  deps: LevelingDeps,
  guildId: string,
  from: number,
  to: number,
): Promise<XpEvent[]> {
  if (!deps.xpEvents) return [];

  try {
    return await deps.xpEvents.overlapping(guildId, from, to);
  } catch (error) {
    ctx.logger.warn(
      `leveling could not read the XP events of server ${guildId}, so no event multiplier ` +
        `applied to this award: ${reason(error)}`,
      { guildId, moduleId: MODULE_ID },
    );
    return [];
  }
}
