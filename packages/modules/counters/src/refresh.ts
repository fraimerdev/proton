import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { type CountersConfig, MODULE_ID, REFRESH_INTERVAL_MS } from './config.ts';
import { createCounterChannel } from './create.ts';
import { bindGuildState, type CountersDeps, describeUnbound } from './deps.ts';
import { NO_STATE, NO_STORE, NOT_WIRED, renameChannel } from './perform.ts';
import { type CounterFailure, type CreationFailure, plan, type RefreshOutcome } from './render.ts';
import type { CounterChannelStore } from './store.ts';

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

  const owned = await readOwned(ctx, deps.channels);
  if ('failed' in owned) return { ok: false, humanReason: owned.failed, permanent: false };

  const steps = plan(ctx.config, state, owned.channels);
  const failures: CounterFailure[] = [];
  const creationFailures: CreationFailure[] = [];
  const unlocked: string[] = [];
  let created = 0;

  for (const creation of steps.creations) {
    if (!deps.channels) {
      creationFailures.push({ name: creation.name, humanReason: NO_STORE });
      continue;
    }

    const outcome = await createCounterChannel(ctx, creation.counterId, creation.name);

    if ('refused' in outcome) {
      creationFailures.push({ name: creation.name, humanReason: outcome.refused });
      continue;
    }

    try {
      await deps.channels.attach(ctx.guildId, creation.counterId, outcome.created);
    } catch (error) {
      creationFailures.push({
        name: creation.name,
        humanReason: `I made the channel but could not record it: ${detailOf(error)}`,
      });
      continue;
    }

    created += 1;
    if (!outcome.locked) unlocked.push(outcome.created);
  }

  const updated = await rename(ctx, steps.edits, idempotencyRoot, failures);

  for (const failure of failures) {
    ctx.logger.error(
      `counter channel ${failure.channelId} was not renamed: ${failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: failure.channelId },
    );
  }

  for (const failure of creationFailures) {
    ctx.logger.error(`no counter channel was made for “${failure.name}”: ${failure.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
  }

  return {
    ok: true,
    outcome: {
      total: ctx.config.counters.length,
      created,
      updated,
      unchanged: steps.unchanged.length,
      unavailable: steps.unavailable.length,
      unlocked,
      failures,
      creationFailures,
    },
  };
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type OwnedChannels = { channels: Map<string, string> } | { failed: string };

async function readOwned(
  ctx: ModuleContext<CountersConfig>,
  store: CounterChannelStore | undefined,
): Promise<OwnedChannels> {
  if (!store) return { channels: new Map() };

  const configured = ctx.config.counters.map((counter) => counter.id);

  try {
    // Swept before it is read, so a counter deleted from the dashboard stops being refreshed the
    // moment it is gone rather than renaming a channel nobody asked about any more.
    const dropped = await store.forgetAllBut(ctx.guildId, configured);

    for (const row of dropped) {
      ctx.logger.info(
        `counter channel ${row.channelId} is no longer configured in this server. Proton will ` +
          'leave it exactly as it is — delete it in Discord if you no longer want it.',
        { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: row.channelId },
      );
    }

    const rows = await store.list(ctx.guildId);

    return { channels: new Map(rows.map((row) => [row.counterId, row.channelId])) };
  } catch (error) {
    const detail = detailOf(error);

    ctx.logger.error(
      `this server’s counter channels were left alone: Proton could not read which channels it ` +
        `already made for them, and treating that as "none yet" would make a second channel for ` +
        `every counter. ${detail}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );

    return {
      failed:
        'I could not look up the counter channels I made for this server, so I left every one ' +
        'of them alone rather than risk making duplicates. Nothing was changed.',
    };
  }
}

async function rename(
  ctx: ModuleContext<CountersConfig>,
  edits: readonly { channelId: string; from: string | null; to: string }[],
  idempotencyRoot: string,
  failures: CounterFailure[],
): Promise<number> {
  let updated = 0;

  for (const edit of edits) {
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

  return updated;
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
