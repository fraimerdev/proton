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

/**
 * What the module did with one destructive audit event.
 *
 * Returned rather than kept internal so a test — and later the dashboard's "why
 * didn't this fire" answer — can distinguish "counted, still under the limit"
 * from "ignored because the actor was us", which are the same silence from
 * outside.
 */
export type AntinukeOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'suppressed'; window: MaintenanceWindow }
  | { action: 'counted'; count: number; limit: number }
  | { action: 'tripped'; report: BreakerReport };

/**
 * Count one destructive act against its actor, and trip the breaker if the
 * window has been crossed.
 *
 * Nothing here looks at the order events arrive in, and nothing may: §15 is
 * explicit that audit-log delivery is eventually consistent and unordered. The
 * only two things that matter are *who* did it and *when it happened* — the
 * latter read off the entry's own snowflake by the normaliser, never off our
 * clock. A shuffled burst therefore trips on exactly the same occurrence as an
 * ordered one.
 */
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

  // The bus round-trips payloads through JSON, so the type is gone by the time a
  // worker sees one and a parse is the only thing between a malformed entry and
  // a breaker decision.
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
    // Discord omits `user_id` on entries with nobody behind them. There is no
    // actor to key a per-actor window on, and inventing one would count several
    // unrelated automatic acts as a single member's burst.
    return { action: 'ignored', reason: 'the audit entry names no actor' };
  }

  const bound = bindDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(bound.unbound), { guildId: ctx.guildId, moduleId: MODULE_ID });
    return { action: 'ignored', reason: 'the module has unbound dependencies' };
  }
  const deps = bound.deps;

  // Every action the executor takes appears in the audit log attributed to the
  // bot — including the ban this module performs itself. Without this the
  // breaker's own response would be read as an attack on the next pass.
  if (actorId === deps.botUserId) {
    return { action: 'ignored', reason: 'the actor is Proton itself' };
  }

  const window = await deps.maintenance.get(ctx.guildId);
  if (window) {
    const covered = isCoveredByMaintenance(window, event.occurredAt);

    // Announced even when this particular act is still covered: the window has
    // run out, and the guild is owed one line saying the breaker is live again.
    // Idempotent on the window rather than the event, so the hundred entries
    // that observe the same lapse produce one message (I4).
    if (hasLapsed(window, deps.now())) await announceLapse(ctx, window);

    if (covered) {
      ctx.logger.info(
        `anti-nuke suppressed: ${event.type} by ${actorId} happened inside the maintenance ` +
          `window ${new Date(window.startedAt).toISOString()} to ` +
          `${new Date(window.expiresAt).toISOString()}, opened by ${window.enabledBy}.`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, actorId },
      );
      // Deliberately not counted, either. A window left loaded with legitimate
      // bulk work would trip on the first ordinary deletion after maintenance
      // ended, which is the same false positive one moment later.
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
    // Namespaced by module, as the rule engine namespaces its own windows, so
    // two subsystems counting the same actor cannot share one counter.
    ruleId: `${MODULE_ID}:${nukeClass}`,
    actorId,
    windowMs: threshold.windowMs,
    limit: threshold.limit,
    // The event id, so a redelivered entry lands on the member it already
    // occupies and is not counted twice (I4).
    member: event.id,
    // When the act happened, not when we heard about it. Audit delivery lags,
    // so the clock would compress a burst that was spread out — and would
    // disagree with itself between first delivery and a RESUME replay.
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

/**
 * Tell the guild that maintenance mode has run out and the breaker is armed.
 *
 * The other half of the audit §8 asks for: switching maintenance on is recorded
 * when an admin does it, and this is the record of it ending. Triggered lazily,
 * by the next destructive event, rather than by a timer — a deliberate choice
 * now that a job runner exists, since a per-guild timer would cost one scheduled
 * job per guild to say the same sentence. The idempotency key is the window's
 * expiry, so whichever path notices first, the message is posted once.
 */
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

/**
 * The listener the manifest declares.
 *
 * It never inspects a raw Discord shape: the normaliser lifted the actor, the
 * target and the reason out of the audit entry (P2.A), so everything below is
 * expressed in Proton's own vocabulary.
 */
export function createAntinukeListener(deps: AntinukeDeps): EventListener<AntinukeConfig> {
  return {
    types: WATCHED_EVENT_TYPES,
    async handler(event, ctx) {
      await handleDestructiveEvent(event, ctx, deps);
    },
  };
}
