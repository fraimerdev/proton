import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { type HoneypotConfig, MODULE_ID } from './config.ts';
import type { HoneypotDeps } from './deps.ts';
import { PUNISH_JOB } from './punish.ts';

export const HONEYPOT_PENDING_EVENT_TYPES: EventType[] = ['member.left', 'entity.ban_added'];

export type PendingOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'settled'; userId: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function userIdOf(event: ProtonEvent): string | null {
  const d = record(event.payload);
  const user = record(d?.user);

  const id = user?.id ?? d?.user_id ?? d?.id;

  return typeof id === 'string' ? id : null;
}

/**
 * A member who left, or whom a moderator banned, while a honeypot punishment was waiting. Without
 * this a softban booked minutes ago would fire its unban leg and lift the moderator's own ban.
 */
export async function markSettled(
  event: ProtonEvent,
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
): Promise<PendingOutcome> {
  if (ctx.config.waitBeforeActingSeconds === 0) {
    return { action: 'ignored', reason: 'this server does not wait before acting' };
  }

  const userId = userIdOf(event);
  if (!userId) return { action: 'ignored', reason: 'unreadable payload' };

  // Cancelled first, then remembered. A sweep that has already claimed the row runs anyway, and
  // the tombstone is what stops it there.
  await ctx.cancel?.(PUNISH_JOB, userId);
  await deps.pending?.settle(ctx.guildId, userId);

  ctx.logger.info(
    `${userId} was dealt with while a honeypot punishment was waiting, so it was called off.`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
  );

  return { action: 'settled', userId };
}

export function createHoneypotPendingListener(deps: HoneypotDeps): EventListener<HoneypotConfig> {
  return {
    types: HONEYPOT_PENDING_EVENT_TYPES,
    async handler(event, ctx) {
      await markSettled(event, ctx, deps);
    },
  };
}
