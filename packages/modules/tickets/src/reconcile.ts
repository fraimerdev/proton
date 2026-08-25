import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { MODULE_ID, type TicketsConfig, typeFor } from './config.ts';
import { bindStore, clockOf, type TicketsDeps } from './deps.ts';
import {
  armTicketTimers,
  cancelTicketTimers,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  SWEEP_JOB,
  SWEEP_KEY,
  schedulesTimers,
} from './schedule.ts';

export const TICKET_CHANNEL_EVENT_TYPES: EventType[] = ['channel.deleted'];

export const TICKET_PATROL_EVENT_TYPES: EventType[] = ['guild.available', 'proton.config_changed'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readDeletedChannel(payload: unknown): string | null {
  const raw = record(payload);
  return str(raw?.id) ?? str(raw?.channel_id);
}

// A ticket channel deleted by hand leaves a row that still holds one of the opener's slots and a
// timer that will keep firing at a channel that is not there. Nothing else notices, because every
// other path starts from an interaction inside the channel.
export async function handleChannelDeleted(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
  deps: TicketsDeps,
): Promise<'ignored' | 'reconciled'> {
  const channelId = readDeletedChannel(event.payload);
  if (!channelId) return 'ignored';

  const bound = bindStore(deps);
  if ('unbound' in bound) return 'ignored';

  const ticket = await bound.store.byChannel(ctx.guildId, channelId);
  if (!ticket) return 'ignored';

  const removed = await bound.store.markDeleted(
    ctx.guildId,
    ticket.id,
    MODULE_ID,
    'the channel was deleted outside Proton',
  );

  if (!removed) return 'ignored';

  await cancelTicketTimers(ctx, removed);

  ctx.logger.info(
    `ticket #${removed.number} was closed off because its channel was deleted by hand. Its slot ` +
      `is free again for <@${removed.ownerId}>.`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, ticketId: removed.id },
  );

  return 'reconciled';
}

export function createTicketChannelListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_CHANNEL_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      await handleChannelDeleted(event, ctx, deps);
    },
  };
}

export async function armPatrol(
  ctx: ModuleContext<TicketsConfig>,
  now: Date = new Date(),
): Promise<void> {
  if (!ctx.schedule) return;

  if (!ctx.config.enabled || !schedulesTimers(ctx.config)) {
    await ctx.cancel?.(SWEEP_JOB, SWEEP_KEY).catch(() => undefined);
    return;
  }

  // Kept, not replaced: guild.available fires for every guild on every gateway identify, and
  // replacing would push the patrol fifteen minutes further out each time — a shard reconnecting
  // more often than that means it never becomes due at all.
  await ctx.schedule(SWEEP_JOB, new Date(now.getTime() + SWEEP_INTERVAL_MS), SWEEP_KEY, {});
}

// A due job for a switched-off module is dropped rather than deferred, so without this the patrol
// stops forever the first time an admin toggles Tickets off and on again.
export function createTicketPatrolListener(deps: TicketsDeps = {}): EventListener<TicketsConfig> {
  return {
    types: TICKET_PATROL_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.type === 'proton.config_changed') {
        const moduleId = str(record(event.payload)?.moduleId);
        if (moduleId !== MODULE_ID) return;
      }

      await armPatrol(ctx, clockOf(deps));
    },
  };
}

export interface PatrolResult {
  inspected: number;
  purged: number;
}

// Timers are armed when a ticket changes, so a ticket whose type gained autoCloseAfter afterwards
// has nothing booked at all. Re-arming from the row's own timestamps is what closes that gap, and
// it is also what recovers a schedule lost to a failed job or a restart mid-write.
export async function patrol(
  ctx: ModuleContext<TicketsConfig>,
  deps: TicketsDeps,
  now: Date = new Date(),
): Promise<PatrolResult> {
  const bound = bindStore(deps);
  if ('unbound' in bound) return { inspected: 0, purged: 0 };

  const due = await bound.store.due(ctx.guildId, SWEEP_BATCH);

  for (const ticket of due) {
    await armTicketTimers(ctx, typeFor(ctx.config, ticket.typeId), ticket);
  }

  const purged = await bound.store.purgeExpiredMessages(now, SWEEP_BATCH);

  await armPatrol(ctx, now);

  return { inspected: due.length, purged };
}
