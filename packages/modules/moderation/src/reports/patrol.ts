import {
  type EventListener,
  type ModuleContext,
  protonConfigChangedSchema,
  type ScheduledHandler,
  tryParseDuration,
} from '@proton/core';
import { describeError } from '@proton/db';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { evaluateTarget, resumeStaleRuns } from './automation.ts';
import { runDeliveryPatrol } from './delivery.ts';
import { deletePrompt } from './reaction.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const PATROL_JOB = 'moderation.reports-patrol';
export const PATROL_KEY = 'patrol';
export const PATROL_INTERVAL_MS = 5 * 60_000;
export const PATROL_TARGETS_MAX = 50;
export const PATROL_PROMPTS_MAX = 25;

export interface AutomationPatrol {
  resumed: number;
  failed: number;
  cancelled: number;
  evaluated: number;
  fired: number;
  prompts: number;
  cursor: string | null;
}

export const patrolDataSchema = z.object({ cursor: z.string().max(32).nullable().catch(null) });

function clock(deps: ModerationDeps): number {
  return deps.now?.() ?? Date.now();
}

function describe(error: unknown): string {
  return describeError(error);
}

function cursorOf(data: unknown): string | null {
  const parsed = patrolDataSchema.safeParse(data ?? {});
  return parsed.success ? parsed.data.cursor : null;
}

export async function armPatrol(
  ctx: Ctx,
  now: number,
  cursor: string | null = null,
): Promise<void> {
  if (!ctx.schedule) return;

  const { reports } = ctx.config;
  if (!ctx.config.enabled || (!reports.enabled && reports.channelId === undefined)) {
    await ctx.cancel?.(PATROL_JOB, PATROL_KEY).catch(() => undefined);
    return;
  }

  // Kept, not replaced: guild.available on every identify would otherwise keep pushing it back.
  await ctx.schedule(PATROL_JOB, new Date(now + PATROL_INTERVAL_MS), PATROL_KEY, { cursor });
}

export function shortestUnreviewedMs(config: ModerationConfig): number | null {
  let shortest: number | null = null;

  for (const rule of config.reports.automation) {
    if (!rule.enabled || rule.conditions.unreviewedFor === null) continue;

    const waitMs = tryParseDuration(rule.conditions.unreviewedFor);
    if (waitMs !== null && (shortest === null || waitMs < shortest)) shortest = waitMs;
  }

  return shortest;
}

async function guarded(ctx: Ctx, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    ctx.logger.error(`the user reports patrol could not ${what}: ${describe(error)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
  }
}

async function timeRules(
  ctx: Ctx,
  deps: ModerationDeps,
  now: number,
  result: AutomationPatrol,
  cursor: string | null,
): Promise<void> {
  const shortest = shortestUnreviewedMs(ctx.config);
  if (!ctx.config.reports.enabled || shortest === null || !deps.reports) return;

  const targets = await deps.reports.targetsWithOpenUnclaimed(
    ctx.guildId,
    now - shortest,
    PATROL_TARGETS_MAX,
    cursor,
  );
  result.cursor = targets.length < PATROL_TARGETS_MAX ? null : (targets.at(-1) ?? null);

  for (const targetId of targets) {
    await guarded(ctx, `check the time-based rules for ${targetId}`, async () => {
      const fired = await evaluateTarget(ctx, deps, targetId, now);
      result.evaluated += 1;
      result.fired += fired.length;
    });
  }
}

async function overduePrompts(
  ctx: Ctx,
  deps: ModerationDeps,
  now: number,
  result: AutomationPatrol,
): Promise<void> {
  if (!deps.prompts) return;

  for (const prompt of await deps.prompts.overdue(ctx.guildId, now, PATROL_PROMPTS_MAX)) {
    await guarded(ctx, `delete the Finish report prompt ${prompt.messageId}`, async () => {
      const outcome = await deletePrompt(ctx, deps, {
        channelId: prompt.channelId,
        messageId: prompt.messageId,
      });
      if (outcome === 'deleted') result.prompts += 1;
    });
  }
}

export async function runAutomationPatrol(
  ctx: Ctx,
  deps: ModerationDeps,
  now: number,
  cursor: string | null = null,
): Promise<AutomationPatrol> {
  const result: AutomationPatrol = {
    resumed: 0,
    failed: 0,
    cancelled: 0,
    evaluated: 0,
    fired: 0,
    prompts: 0,
    cursor: null,
  };
  if (!ctx.config.enabled) return result;

  await guarded(ctx, 'resume interrupted automation runs', async () => {
    Object.assign(result, await resumeStaleRuns(ctx, deps, now));
  });
  await guarded(ctx, 'check the time-based automation rules', () =>
    timeRules(ctx, deps, now, result, cursor),
  );
  await guarded(ctx, 'delete overdue Finish report prompts', () =>
    overduePrompts(ctx, deps, now, result),
  );

  return result;
}

export function createPatrolHandler(deps: ModerationDeps): ScheduledHandler<ModerationConfig> {
  return async (data, ctx) => {
    if (!ctx.config.enabled) return;

    const now = clock(deps);
    let next: string | null = null;
    try {
      await runDeliveryPatrol(ctx, deps, now);
      next = (await runAutomationPatrol(ctx, deps, now, cursorOf(data))).cursor;
    } finally {
      await armPatrol(ctx, now, next);
    }
  };
}

export function createPatrolArmingListener(deps: ModerationDeps): EventListener<ModerationConfig> {
  return {
    types: ['guild.available', 'proton.config_changed', 'moderation.report_submitted'],

    async handler(event, ctx) {
      if (event.type === 'proton.config_changed') {
        const changed = protonConfigChangedSchema.safeParse(event.payload);
        if (!changed.success || changed.data.moduleId !== MODULE_ID) return;

        await armPatrol(ctx, clock(deps));
        return;
      }

      if (!ctx.config.enabled) return;
      await armPatrol(ctx, clock(deps));
    },
  };
}
