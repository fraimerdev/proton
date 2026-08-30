import type {
  ActionResult,
  EventListener,
  EventType,
  ModuleContext,
  ProtonEvent,
  ScheduledHandler,
} from '@proton/core';
import { HONEYPOT_ACTOR, type HoneypotConfig, MODULE_ID } from './config.ts';
import type { HoneypotDeps } from './deps.ts';

export const CAMO_JOB = 'camouflage';

// One row, one reschedule loop, one chance to strand it. Two schedules — one per leg — would be
// two of each, and a leg whose row was lost would stop silently while the other kept running.
export const CAMO_KEY = 'all';

export const CAMO_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const CHANNEL_NAME_MAX = 100;

// Deliberately dull. A bait channel that reads as somebody's project is a channel a member might
// answer in; these say nothing anybody would reply to.
export const KEEP_ALIVE_LINES = [
  'Routine check. Nothing here needs a reply.',
  'Automated check-in. No action needed.',
  'Still here. Nothing to do.',
  'Scheduled check. Please carry on.',
  'Nothing new. This message is automatic.',
  'Periodic check. No reply needed.',
  'System check complete.',
] as const;

export const NAME_SUFFIXES = [
  'archive',
  'notes',
  'scratch',
  'staging',
  'drafts',
  'overflow',
  'misc',
] as const;

export function daySlot(now: number): number {
  return Math.floor(now / CAMO_INTERVAL_MS);
}

// Derived from the day and the channel rather than random: the same day redelivered must produce
// the same name and the same line, or a retry renames the channel twice and burns the allowance.
export function pick<T>(options: readonly T[], channelId: string, slot: number): T {
  let hash = slot;
  for (const character of channelId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;

  return options[hash % options.length] as T;
}

export function camouflageName(base: string, channelId: string, slot: number): string {
  const suffix = pick(NAME_SUFFIXES, channelId, slot);
  const stem = base.replace(/-(?:archive|notes|scratch|staging|drafts|overflow|misc)$/, '');

  return `${stem}-${suffix}`.slice(0, CHANNEL_NAME_MAX);
}

export interface CamouflageOutcome {
  posted: string[];
  renamed: string[];
  failures: Array<{ channelId: string; humanReason: string }>;
}

function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export async function runCamouflage(
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
  now: number,
): Promise<CamouflageOutcome> {
  const slot = daySlot(now);
  const outcome: CamouflageOutcome = { posted: [], renamed: [], failures: [] };

  const armed = ctx.config.channels.filter((channel) => channel.enabled);
  const state = deps.guildState ? await deps.guildState.get(ctx.guildId) : null;

  for (const channel of armed) {
    if (ctx.config.keepChannelActive) {
      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'send',
        actorId: HONEYPOT_ACTOR,
        dryRun: false,
        record: false,
        idempotencyKey: `${MODULE_ID}:${ctx.guildId}:camo-post:${channel.channelId}:${slot}`,
        payload: {
          channelId: channel.channelId,
          content: pick(KEEP_ALIVE_LINES, channel.channelId, slot),
          allowedMentions: { parse: [] },
        },
      });

      if (succeeded(result)) outcome.posted.push(channel.channelId);
      else {
        outcome.failures.push({
          channelId: channel.channelId,
          humanReason: result.failure?.humanReason ?? 'Discord gave no reason.',
        });
      }
    }

    if (ctx.config.renameChannelDaily) {
      const base = state?.channels.get(channel.channelId)?.name;

      if (base === undefined) {
        outcome.failures.push({
          channelId: channel.channelId,
          humanReason: 'Proton does not know what this channel is currently called.',
        });
        continue;
      }

      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'edit_channel',
        actorId: HONEYPOT_ACTOR,
        dryRun: false,
        record: false,
        idempotencyKey: `${MODULE_ID}:${ctx.guildId}:camo-name:${channel.channelId}:${slot}`,
        payload: {
          channelId: channel.channelId,
          name: camouflageName(base, channel.channelId, slot),
        },
      });

      if (succeeded(result)) outcome.renamed.push(channel.channelId);
      else {
        outcome.failures.push({
          channelId: channel.channelId,
          humanReason: result.failure?.humanReason ?? 'Discord gave no reason.',
        });
      }
    }
  }

  for (const failure of outcome.failures) {
    ctx.logger.warn(`honeypot could not camouflage ${failure.channelId}: ${failure.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      channelId: failure.channelId,
    });
  }

  return outcome;
}

export function wanted(config: HoneypotConfig): boolean {
  return (
    config.enabled &&
    (config.keepChannelActive || config.renameChannelDaily) &&
    config.channels.some((channel) => channel.enabled)
  );
}

export function createCamouflageHandler(deps: HoneypotDeps): ScheduledHandler<HoneypotConfig> {
  return async (_data, ctx) => {
    if (!wanted(ctx.config)) {
      ctx.logger.info(
        'honeypot camouflage stopped in this server: it is switched off, or no bait channel is ' +
          'armed. Saving the module’s settings starts it again.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const now = deps.now?.() ?? Date.now();

    // Each leg already isolates its own failures; this catches a throw out of the executor itself,
    // which would otherwise take the reschedule with it and stop camouflage for good.
    try {
      await runCamouflage(ctx, deps, now);
    } catch (error) {
      ctx.logger.error(
        `honeypot camouflage failed outright: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    }

    await ctx.schedule?.(CAMO_JOB, new Date(now + CAMO_INTERVAL_MS), CAMO_KEY, undefined, {
      replace: true,
    });
  };
}

export const CAMO_EVENT_TYPES: EventType[] = ['guild.available', 'proton.config_changed'];

export type CamouflageSchedule = 'booked' | 'cancelled' | 'unscheduled' | 'ignored';

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

export async function reconcileCamouflage(
  event: ProtonEvent,
  ctx: ModuleContext<HoneypotConfig>,
): Promise<CamouflageSchedule> {
  const ourChange = event.type === 'proton.config_changed';
  if (ourChange && field(event.payload, 'moduleId') !== MODULE_ID) return 'ignored';

  // The module-level switch is not in the config schema, so a module that was just turned off can
  // only learn it from the event that announced the change — and it has to, to stop the loop.
  const active = ourChange ? field(event.payload, 'enabledAfter') !== false : true;

  if (!(active && wanted(ctx.config))) {
    await ctx.cancel?.(CAMO_JOB, CAMO_KEY);
    return 'cancelled';
  }

  if (!ctx.schedule) {
    ctx.logger.error(
      'this server’s bait channels will never be camouflaged: this deployment has no durable ' +
        'scheduler wired into the module runtime, so nothing books the daily job.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return 'unscheduled';
  }

  // Not replaced on guild.available: a pending run is already due within the day, and moving it to
  // now on every reconnect would spend a rename allowance per restart.
  await ctx.schedule(CAMO_JOB, new Date(), CAMO_KEY, undefined, { replace: ourChange });

  return 'booked';
}

export function createCamouflageListener(): EventListener<HoneypotConfig> {
  return {
    types: CAMO_EVENT_TYPES,
    handler: async (event, ctx) => {
      await reconcileCamouflage(event, ctx);
    },
  };
}
