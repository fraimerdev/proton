import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { type CountersConfig, MODULE_ID } from './config.ts';
import { REFRESH_JOB, REFRESH_KEY } from './refresh.ts';

export const COUNTERS_EVENT_TYPES: EventType[] = ['guild.available', 'proton.config_changed'];

export type ScheduleOutcomeName = 'booked' | 'cancelled' | 'unscheduled' | 'ignored';

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

export async function reconcileSchedule(
  event: ProtonEvent,
  ctx: ModuleContext<CountersConfig>,
): Promise<ScheduleOutcomeName> {
  const ourChange = event.type === 'proton.config_changed';
  if (ourChange && field(event.payload, 'moduleId') !== MODULE_ID) return 'ignored';

  // The module-level switch is not in the config schema, so a module that was just turned off can
  // only learn it from the event that announced the change — and it has to, to stop the loop.
  const active = ourChange ? field(event.payload, 'enabledAfter') !== false : true;

  const wanted = active && ctx.config.enabled && ctx.config.counters.length > 0;

  if (!wanted) {
    await ctx.cancel?.(REFRESH_JOB, REFRESH_KEY);
    return 'cancelled';
  }

  if (!ctx.schedule) {
    ctx.logger.error(
      'this server’s counter channels will never refresh on their own: this deployment has no ' +
        'durable scheduler wired into the module runtime, so nothing books the 10-minute ' +
        'refresh. /counters refresh still updates them by hand.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return 'unscheduled';
  }

  // Not replaced on guild.available: a pending refresh is already due within ten minutes, and
  // moving it to now on every reconnect would spend a rename allowance per restart.
  await ctx.schedule(REFRESH_JOB, new Date(), REFRESH_KEY, undefined, { replace: ourChange });

  return 'booked';
}

export function createCountersListener(): EventListener<CountersConfig> {
  return {
    types: COUNTERS_EVENT_TYPES,

    handler: async (event, ctx) => {
      await reconcileSchedule(event, ctx);
    },
  };
}
