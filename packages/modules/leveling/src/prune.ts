import type { EventListener, EventType, ModuleContext, ScheduledHandler } from '@proton/core';
import { ACTIVITY_RETENTION_DAYS, type ActivityStore } from './activity.ts';
import { type LevelingConfig, XP_EVENT_RETENTION_MS } from './config.ts';
import { clockOf, type LevelingDeps } from './deps.ts';
import { LEVELING_MODULE_ID } from './providers.ts';
import type { XpEventStore } from './xp-events.ts';

export const PRUNE_JOB_ID = 'prune-activity';
export const PRUNE_KEY = 'daily';

const DAY_MS = 24 * 60 * 60 * 1000;

export const PRUNE_INTERVAL_MS = DAY_MS;

export const PRUNE_EVENT_TYPES: EventType[] = ['guild.available', 'proton.config_changed'];

export async function armPrune(ctx: ModuleContext<LevelingConfig>, now: number): Promise<void> {
  if (!ctx.schedule) return;

  if (!ctx.config.enabled) {
    await ctx.cancel?.(PRUNE_JOB_ID, PRUNE_KEY).catch(() => undefined);
    return;
  }

  // Kept, not replaced: guild.available fires on every identify and would keep pushing it out.
  await ctx.schedule(PRUNE_JOB_ID, new Date(now + PRUNE_INTERVAL_MS), PRUNE_KEY, {});
}

// A due job for a switched-off module is dropped, so this is what restarts the prune afterwards.
export function createPruneListener(deps: LevelingDeps): EventListener<LevelingConfig> {
  const now = clockOf(deps);

  return {
    types: PRUNE_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.type === 'proton.config_changed') {
        const payload = event.payload as { moduleId?: unknown } | null;
        if (payload?.moduleId !== LEVELING_MODULE_ID) return;
      }

      await armPrune(ctx, now());
    },
  };
}

export function createPruneHandler(
  activity: ActivityStore,
  now: (() => number) | undefined,
  xpEvents?: XpEventStore,
): ScheduledHandler<LevelingConfig> {
  return async (_data, ctx) => {
    const at = now?.() ?? Date.now();
    const before = new Date(at - ACTIVITY_RETENTION_DAYS * DAY_MS);
    const removed = await activity.prune(ctx.guildId, before);

    if (removed > 0) {
      ctx.logger.info(
        `pruned ${removed} activity row(s) older than ${ACTIVITY_RETENTION_DAYS} days`,
        { guildId: ctx.guildId, moduleId: LEVELING_MODULE_ID },
      );
    }

    if (xpEvents) await purgeXpEvents(ctx, xpEvents, at);

    await armPrune(ctx, at);
  };
}

async function purgeXpEvents(
  ctx: ModuleContext<LevelingConfig>,
  xpEvents: XpEventStore,
  at: number,
): Promise<void> {
  try {
    const purged = await xpEvents.purgeEndedBefore(ctx.guildId, at - XP_EVENT_RETENTION_MS);

    if (purged > 0) {
      ctx.logger.info(`cleared out ${purged} XP event(s) that ended over a week ago`, {
        guildId: ctx.guildId,
        moduleId: LEVELING_MODULE_ID,
      });
    }
  } catch (error) {
    ctx.logger.warn(
      'leveling could not clear out the XP events that ended over a week ago; the next daily ' +
        `prune tries again: ${error instanceof Error ? error.message : String(error)}`,
      { guildId: ctx.guildId, moduleId: LEVELING_MODULE_ID },
    );
  }
}
