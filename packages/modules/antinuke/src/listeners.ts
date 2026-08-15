import {
  auditLogEventPayloadSchema,
  type EventListener,
  type ModuleContext,
  type ProtonEvent,
} from '@proton/core';
import { announce, type BreakerReport, MODULE_ID, tripBreaker } from './breaker.ts';
import { classOfEvent, thresholdFor, WATCHED_EVENT_TYPES } from './classes.ts';
import type { AntinukeConfig } from './config.ts';
import { type AntinukeDeps, bindDeps, describeUnbound } from './deps.ts';
import { hasLapsed, isCoveredByMaintenance, type MaintenanceWindow } from './maintenance.ts';

export type AntinukeOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'suppressed'; window: MaintenanceWindow }
  | { action: 'counted'; count: number; limit: number }
  | { action: 'tripped'; report: BreakerReport };

export async function handleDestructiveEvent(
  event: ProtonEvent,
  ctx: ModuleContext<AntinukeConfig>,
  rawDeps: AntinukeDeps,
): Promise<AntinukeOutcome> {
  if (!ctx.config.enabled) return { action: 'ignored', reason: 'anti-nuke is off in this server' };

  const nukeClass = classOfEvent(event.type);
  if (!nukeClass) {
    return { action: 'ignored', reason: `${event.type} is not a class anti-nuke counts` };
  }

  const payload = auditLogEventPayloadSchema.safeParse(event.payload);
  if (!payload.success) {
    ctx.logger.error(
      `anti-nuke received a ${event.type} whose audit payload it could not read, so nobody was ` +
        'counted for it. This is a gateway/normaliser mismatch, not a configuration problem.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable audit payload' };
  }

  const actorId = payload.data.actorId;
  if (!actorId) {
    return { action: 'ignored', reason: 'the audit entry names no actor' };
  }

  const bound = bindDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(bound.unbound), { guildId: ctx.guildId, moduleId: MODULE_ID });
    return { action: 'ignored', reason: 'the module has unbound dependencies' };
  }
  const deps = bound.deps;

  if (actorId === deps.botUserId) {
    return { action: 'ignored', reason: 'the actor is Proton itself' };
  }

  const window = await deps.maintenance.get(ctx.guildId);
  if (window) {
    const covered = isCoveredByMaintenance(window, event.occurredAt);

    if (hasLapsed(window, deps.now())) await announceLapse(ctx, window);

    if (covered) {
      ctx.logger.info(
        `anti-nuke suppressed: ${event.type} by ${actorId} happened inside the maintenance ` +
          `window ${new Date(window.startedAt).toISOString()} to ` +
          `${new Date(window.expiresAt).toISOString()}, opened by ${window.enabledBy}.`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, actorId },
      );

      return { action: 'suppressed', window };
    }
  }

  const threshold = thresholdFor(ctx.config, nukeClass);
  if ('error' in threshold) {
    ctx.logger.error(`anti-nuke could not evaluate ${nukeClass}: ${threshold.error}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'ignored', reason: threshold.error };
  }

  const { count, tripped } = await deps.rateWindow.hit({
    guildId: ctx.guildId,

    ruleId: `${MODULE_ID}:${nukeClass}`,
    actorId,
    windowMs: threshold.windowMs,
    limit: threshold.limit,

    member: event.id,

    now: event.occurredAt,
  });

  if (!tripped) return { action: 'counted', count, limit: threshold.limit };

  const report = await tripBreaker(ctx, deps, {
    actorId,
    nukeClass,
    count,
    limit: threshold.limit,
    window: threshold.window,
    eventId: event.id,
  });

  return { action: 'tripped', report };
}

export async function announceLapse(
  ctx: ModuleContext<AntinukeConfig>,
  window: MaintenanceWindow,
): Promise<void> {
  const summary =
    `Anti-nuke maintenance mode ended at ${new Date(window.expiresAt).toISOString()} and the ` +
    `breaker is armed again. It was opened by ${window.enabledBy}` +
    `${window.reason ? ` for: ${window.reason}` : ''}.`;

  ctx.logger.info(summary, { guildId: ctx.guildId, moduleId: MODULE_ID });
  await announce(ctx, `maintenance-lapsed:${ctx.guildId}:${window.expiresAt}`, summary, 'lapsed');
}

export function createAntinukeListener(deps: AntinukeDeps): EventListener<AntinukeConfig> {
  return {
    types: WATCHED_EVENT_TYPES,
    async handler(event, ctx) {
      await handleDestructiveEvent(event, ctx, deps);
    },
  };
}
