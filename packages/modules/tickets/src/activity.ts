import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { MODULE_ID, staffRolesFor, type TicketsConfig, typeFor } from './config.ts';
import { bindStore, clockOf, type TicketsDeps } from './deps.ts';
import { armTicketTimers } from './schedule.ts';
import type { TicketAttachment, TicketStore } from './store.ts';

export const TICKET_ACTIVITY_EVENT_TYPES: EventType[] = [
  'message.created',
  'message.updated',
  'message.deleted',
];

// One throttled write per minute per ticket channel. Bumping the row on every message would make a
// busy ticket the hottest write in the guild, and a minute of drift on a timer measured in hours
// changes nothing.
export const ACTIVITY_THROTTLE_MS = 60_000;

// The recorded retention decision for message content: opt-in, thirty days. Stored per row rather
// than derived on read so the purge never has to re-read a guild's config to know what is due.
export const TRANSCRIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface ActivityMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  roleIds: string[];
  content: string;
  attachments: TicketAttachment[];
  embeds: Array<Record<string, unknown>>;
  replyToId: string | null;
}

export function readActivity(payload: unknown): ActivityMessage | null {
  const raw = record(payload);
  const channelId = str(raw?.channel_id);
  if (!raw || !channelId) return null;

  const author = record(raw.author);
  const member = record(raw.member);

  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments
        .map(record)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          url: str(entry.url) ?? '',
          filename: str(entry.filename) ?? 'file',
          contentType: str(entry.content_type),
          size: typeof entry.size === 'number' ? entry.size : 0,
        }))
        .filter((entry) => entry.url !== '')
    : [];

  return {
    messageId: str(raw.id) ?? '',
    channelId,
    authorId: str(author?.id) ?? '',
    authorName: str(author?.global_name) ?? str(author?.username) ?? str(author?.id) ?? 'unknown',
    isBot: author?.bot === true,
    roleIds: Array.isArray(member?.roles)
      ? member.roles.filter((role): role is string => typeof role === 'string')
      : [],
    content: str(raw.content) ?? '',
    attachments,
    embeds: Array.isArray(raw.embeds)
      ? raw.embeds.filter((entry): entry is Record<string, unknown> => record(entry) !== null)
      : [],
    replyToId:
      str(record(raw.referenced_message)?.id) ?? str(record(raw.message_reference)?.message_id),
  };
}

export function watchesActivity(config: TicketsConfig): boolean {
  return config.types.some(
    (type) =>
      type.autoCloseAfter !== undefined ||
      type.inactivityWarnAfter !== undefined ||
      type.captureMessages,
  );
}

export async function handleActivity(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
  deps: TicketsDeps,
  now: Date = new Date(),
): Promise<void> {
  // Gated on config before the query: a guild with no auto-closing and no capturing ticket type
  // must not pay a database read for every message anybody sends in it.
  if (!watchesActivity(ctx.config)) return;

  const message = readActivity(event.payload);
  if (message === null) return;

  const bound = bindStore(deps);
  if ('unbound' in bound) return;

  if (event.type === 'message.updated') {
    await onEdited(ctx, bound.store, message, now);
    return;
  }

  if (event.type === 'message.deleted') {
    await onDeleted(ctx, bound.store, message, now);
    return;
  }

  if (message.isBot) return;

  const ticket = await bound.store.byChannel(ctx.guildId, message.channelId);
  if (ticket?.status !== 'open') return;

  const type = typeFor(ctx.config, ticket.typeId);
  const staff = new Set(staffRolesFor(ctx.config, type));

  // The opener answering in their own ticket is never "staff replied", even when they hold a
  // support role — otherwise their own message would stop the clock that is waiting on the team.
  const fromStaff =
    message.authorId !== ticket.ownerId && message.roleIds.some((roleId) => staff.has(roleId));

  const updated = await bound.store.recordActivity(ctx.guildId, message.channelId, {
    fromStaff,
    at: now,
  });

  if (type?.captureMessages && message.messageId) {
    await bound.store.captureMessage({
      ticketId: ticket.id,
      messageId: message.messageId,
      authorId: message.authorId,
      authorName: message.authorName,
      authorBot: message.isBot,
      content: message.content,
      attachments: message.attachments,
      embeds: message.embeds,
      replyToId: message.replyToId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TRANSCRIPT_RETENTION_MS),
    });
  }

  // Re-armed on every message rather than left where it was: the timer measures inactivity, so a
  // ticket somebody just spoke in has a later deadline than the one currently booked.
  if (updated) await armTicketTimers(ctx, type, updated);
}

async function onEdited(
  ctx: ModuleContext<TicketsConfig>,
  store: TicketStore,
  message: ActivityMessage,
  now: Date,
): Promise<void> {
  if (!message.messageId) return;

  const ticket = await store.byChannel(ctx.guildId, message.channelId);
  if (!ticket || !typeFor(ctx.config, ticket.typeId)?.captureMessages) return;

  await store.markMessageEdited(ticket.id, message.messageId, message.content, now);
}

async function onDeleted(
  ctx: ModuleContext<TicketsConfig>,
  store: TicketStore,
  message: ActivityMessage,
  now: Date,
): Promise<void> {
  if (!message.messageId) return;

  const ticket = await store.byChannel(ctx.guildId, message.channelId);
  if (!ticket || !typeFor(ctx.config, ticket.typeId)?.captureMessages) return;

  // Marked, not removed: a message deleted mid-argument is exactly the one a transcript is read
  // for, and the row already expires on its own.
  await store.markMessageDeleted(ticket.id, message.messageId, now);
}

export function createTicketActivityListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_ACTIVITY_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      await handleActivity(event, ctx, deps, clockOf(deps));
    },
  };
}

export const TICKETS_MODULE_ID = MODULE_ID;
