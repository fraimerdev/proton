import type { ScheduledHandler } from '@proton/core';
import { ACTIVITY_RETENTION_DAYS, type ActivityStore } from './activity.ts';
import type { LevelingConfig } from './config.ts';

export const PRUNE_JOB_ID = 'prune-activity';

const DAY_MS = 24 * 60 * 60 * 1000;

export function createPruneHandler(
  activity: ActivityStore,
  now: (() => number) | undefined,
): ScheduledHandler<LevelingConfig> {
  return async (_data, ctx) => {
    const before = new Date((now?.() ?? Date.now()) - ACTIVITY_RETENTION_DAYS * DAY_MS);
    const removed = await activity.prune(before);

    if (removed > 0) {
      ctx.logger.info(
        `pruned ${removed} activity row(s) older than ${ACTIVITY_RETENTION_DAYS} days`,
        { guildId: ctx.guildId, moduleId: 'leveling' },
      );
    }
  };
}
