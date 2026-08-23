import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { type CountersConfig, MODULE_ID, REFRESH_INTERVAL_MS } from './config.ts';
import { bindGuildState, type CountersDeps, describeUnbound } from './deps.ts';
import { NO_STATE, NOT_WIRED, renameChannel } from './perform.ts';
import { type CounterFailure, plan, type RefreshOutcome } from './render.ts';

export const REFRESH_JOB = 'refresh';

export const REFRESH_KEY = 'all';

export type RefreshResult =
  | { ok: true; outcome: RefreshOutcome }
  | { ok: false; humanReason: string; permanent: boolean };

// Keyed on the ten-minute slot rather than on the name being written: the same run redelivered is
// one rename, but a count that goes back to a value it held an hour ago must still be rewritten.
export function refreshKeyRoot(guildId: string, now: number): string {
  return `${MODULE_ID}:${guildId}:${Math.floor(now / REFRESH_INTERVAL_MS)}`;
}

export async function refreshCounters(
  ctx: ModuleContext<CountersConfig>,
  deps: CountersDeps,
  idempotencyRoot: string,
): Promise<RefreshResult> {
  const bound = bindGuildState(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the counter refresh', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { ok: false, humanReason: NOT_WIRED, permanent: true };
  }

  const state = await bound.guildState.get(ctx.guildId);
  if (!state) return { ok: false, humanReason: NO_STATE, permanent: false };

  const steps = plan(ctx.config, state);
  const failures: CounterFailure[] = [];
  let updated = 0;

  for (const edit of steps.edits) {
    const result = await renameChannel(ctx, edit, `${idempotencyRoot}:${edit.channelId}`);

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      failures.push({
        channelId: edit.channelId,
        humanReason: result.failure?.humanReason ?? 'Discord gave no reason.',
      });
      continue;
    }

    if (result.status === 'executed') updated += 1;
  }

  for (const failure of failures) {
    ctx.logger.error(
      `counter channel ${failure.channelId} was not renamed: ${failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: failure.channelId },
    );
  }

  return {
    ok: true,
    outcome: {
      total: ctx.config.counters.length,
      updated,
      unchanged: steps.unchanged.length,
      unavailable: steps.unavailable.length,
      failures,
    },
  };
}

async function reschedule(ctx: ModuleContext<CountersConfig>, from: number): Promise<void> {
  if (!ctx.schedule) {
    ctx.logger.error(
      'this server’s counter channels were refreshed once and will now stop: this deployment ' +
        'has no durable scheduler wired into the module runtime, so nothing can book the next ' +
        'refresh. Until that is wired up, /counters refresh is the only way to update them.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  await ctx.schedule(REFRESH_JOB, new Date(from + REFRESH_INTERVAL_MS), REFRESH_KEY, undefined, {
    replace: true,
  });
}

export function createRefreshHandler(deps: CountersDeps): ScheduledHandler<CountersConfig> {
  return async (_data, ctx) => {
    if (!ctx.config.enabled || ctx.config.counters.length === 0) {
      ctx.logger.info(
        'the counter refresh stopped in this server: counter channels are switched off or none ' +
          'are configured. Saving the module’s settings starts it again.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const now = Date.now();
    const result = await refreshCounters(ctx, deps, refreshKeyRoot(ctx.guildId, now));

    if (!result.ok) {
      ctx.logger.error(result.humanReason, { guildId: ctx.guildId, moduleId: MODULE_ID });
      if (result.permanent) return;
    }

    await reschedule(ctx, now);
  };
}
