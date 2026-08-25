import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { type GiveawaysConfig, MODULE_ID } from './config.ts';
import { bindStore, type GiveawaysDeps } from './deps.ts';

export const CLEANUP_EVENT_TYPES: EventType[] = [
  'message.deleted',
  'message.bulk_deleted',
  'channel.deleted',
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readDeletedChannel(payload: unknown): string | null {
  const raw = record(payload);
  return str(raw?.id) ?? str(raw?.channel_id);
}

/** MESSAGE_DELETE carries `id`; MESSAGE_DELETE_BULK carries `ids`. */
export function readDeletedMessages(payload: unknown): string[] {
  const raw = record(payload);
  if (!raw) return [];

  const single = str(raw.id);
  if (single !== null) return [single];

  return Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === 'string') : [];
}

export type CleanupOutcome = 'ignored' | 'orphaned';

/**
 * A giveaway whose message is gone still has a `message_id`, and every later edit — the debounced
 * count, the ended card, a reroll repaint — 404s against it forever. `report()` swallows the
 * failure as a warn, so nothing ever stops trying. Clearing the id is what stops it.
 *
 * The giveaway itself is kept: the entries are real, the draw can still run, and only the host can
 * decide whether losing the message is worth cancelling over.
 */
export async function handleMessageDeleted(
  event: ProtonEvent,
  ctx: ModuleContext<GiveawaysConfig>,
  deps: GiveawaysDeps,
): Promise<CleanupOutcome> {
  const bound = bindStore(deps);
  if ('unbound' in bound) return 'ignored';

  let orphaned = 0;

  for (const messageId of readDeletedMessages(event.payload)) {
    const giveaway = await bound.bound.store.byMessage(ctx.guildId, messageId);
    if (!giveaway) continue;

    if (await bound.bound.store.clearMessage(ctx.guildId, giveaway.id)) orphaned += 1;

    ctx.logger.warn(
      `the giveaway message for '${giveaway.title}' was deleted, so Proton has stopped trying to ` +
        'update it. The giveaway itself is untouched and will still be drawn — repost it with ' +
        '`/giveaway info` to find it, or cancel it with `/giveaway cancel`.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, giveawayId: giveaway.id },
    );
  }

  return orphaned > 0 ? 'orphaned' : 'ignored';
}

export async function handleChannelDeleted(
  event: ProtonEvent,
  ctx: ModuleContext<GiveawaysConfig>,
  deps: GiveawaysDeps,
): Promise<CleanupOutcome> {
  const channelId = readDeletedChannel(event.payload);
  if (channelId === null) return 'ignored';

  const bound = bindStore(deps);
  if ('unbound' in bound) return 'ignored';

  const affected = await bound.bound.store.byChannel(ctx.guildId, channelId);
  if (affected.length === 0) return 'ignored';

  let orphaned = 0;
  for (const giveaway of affected) {
    if (await bound.bound.store.clearMessage(ctx.guildId, giveaway.id)) orphaned += 1;
  }

  if (orphaned > 0) {
    ctx.logger.warn(
      `${orphaned} giveaway message(s) went away with a deleted channel. The giveaways are kept ` +
        'and can still be drawn, but there is nowhere left to announce them — cancel them, or ' +
        'move them with `/giveaway edit`.',
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        channelId,
        giveawayIds: affected.map((giveaway) => giveaway.id),
      },
    );
  }

  return orphaned > 0 ? 'orphaned' : 'ignored';
}

export function createGiveawayCleanupListener(
  deps: GiveawaysDeps = {},
): EventListener<GiveawaysConfig> {
  return {
    types: CLEANUP_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      if (event.type === 'channel.deleted') {
        await handleChannelDeleted(event, ctx, deps);
        return;
      }

      await handleMessageDeleted(event, ctx, deps);
    },
  };
}
