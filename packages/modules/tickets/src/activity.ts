import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { MODULE_ID, type TicketsConfig } from './config.ts';
import { bindStore, type TicketsDeps } from './deps.ts';

export const TICKET_ACTIVITY_EVENT_TYPES: EventType[] = ['message.created'];

// One write per minute per ticket channel at most. Bumping the row on every message would make a
// busy ticket the hottest write in the guild, and a minute of drift on a timer measured in hours
// changes nothing.
export const ACTIVITY_THROTTLE_MS = 60_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface ActivityMessage {
  channelId: string;
  isBot: boolean;
}

export function readActivity(payload: unknown): ActivityMessage | null {
  const raw = record(payload);
  const channelId = typeof raw?.channel_id === 'string' ? raw.channel_id : null;
  if (!raw || !channelId) return null;

  return { channelId, isBot: record(raw.author)?.bot === true };
}

export function watchesActivity(config: TicketsConfig): boolean {
  return config.panels.some((panel) => panel.autoCloseAfter !== undefined);
}

export async function handleActivity(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
  deps: TicketsDeps,
  now: Date = new Date(),
): Promise<void> {
  // Gated on config before the query: a guild with no auto-closing panel must not pay a database
  // read for every message anybody sends in it.
  if (!watchesActivity(ctx.config)) return;

  const message = readActivity(event.payload);
  if (message === null || message.isBot) return;

  const bound = bindStore(deps);
  if ('unbound' in bound) return;

  await bound.store.touch(
    ctx.guildId,
    message.channelId,
    new Date(now.getTime() - ACTIVITY_THROTTLE_MS),
  );
}

export function createTicketActivityListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_ACTIVITY_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      await handleActivity(event, ctx, deps);
    },
  };
}

export const TICKETS_MODULE_ID = MODULE_ID;
