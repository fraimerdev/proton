import type { EventListener, EventType } from '@proton/core';
import { type LevelingConfig, readSettings, rollMessageXp } from './config.ts';
import { bindXp, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { MODULE_ID } from './perform.ts';

export const MESSAGE_XP_EVENT_TYPES: EventType[] = ['message.created'];

/**
 * Discord message types that count as somebody talking.
 *
 * 0 is an ordinary message and 19 is a reply. Everything else in the enum is
 * Discord narrating the channel — "X joined the server", "X pinned a message",
 * a thread starter, a slash-command echo — and awarding XP for those would mean
 * a member could level up by joining, or by pinning things.
 */
const CONVERSATIONAL_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19]);

/** The fields of a Discord message this module reads, and no others. */
export interface XpMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
  isWebhook: boolean;
  type: number;
  /**
   * The author's roles. Guild messages carry a partial member object; a webhook
   * or a DM does not, and null means "not stated" rather than "none".
   */
  roleIds: string[] | null;
}

/**
 * Pull what is needed out of the raw dispatch.
 *
 * The gateway hands listeners Discord's own object for message events, so this
 * is the one place in the module that knows its shape. Returns null rather than
 * throwing for anything unreadable — a throw would leave the bus entry unacked
 * and the same event would be redelivered forever.
 *
 * `content` is never read. Message XP is for taking part, not for what was said,
 * which is what lets this module leave the privileged MESSAGE_CONTENT intent
 * alone (see the manifest).
 */
export function readMessage(payload: unknown): XpMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  const messageId = typeof raw.id === 'string' ? raw.id : null;
  const channelId = typeof raw.channel_id === 'string' ? raw.channel_id : null;
  if (messageId === null || channelId === null) return null;

  const author = (
    typeof raw.author === 'object' && raw.author !== null ? raw.author : {}
  ) as Record<string, unknown>;
  const authorId = author.id;
  if (typeof authorId !== 'string') return null;

  const member = typeof raw.member === 'object' && raw.member !== null ? raw.member : null;
  const rawRoles = member === null ? null : (member as Record<string, unknown>).roles;

  return {
    messageId,
    channelId,
    authorId,
    isBot: author.bot === true,
    isWebhook: typeof raw.webhook_id === 'string',
    type: typeof raw.type === 'number' ? raw.type : 0,
    roleIds: Array.isArray(rawRoles)
      ? rawRoles.filter((role): role is string => typeof role === 'string')
      : null,
  };
}

/**
 * Award XP for talking (PLAN.md §8 Phase 3).
 *
 * The hottest write path in the system — one row per member per cooldown window
 * — so the shape here matters: every cheap check that can rule a message out
 * happens before the store is touched, and the store touch itself is one
 * statement that does the cooldown check in SQL (R2). No Redis pre-filter in
 * front of it, deliberately: the plan says measure first, and a second source of
 * truth for "has this member earned recently" is exactly the kind of thing that
 * drifts from the database it is meant to protect.
 */
export function createMessageXpListener(deps: LevelingDeps): EventListener<LevelingConfig> {
  return {
    types: MESSAGE_XP_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      // A DM has no guild, no leaderboard and no config that applies. The
      // normaliser sets `guildId` to null for those rather than dropping them,
      // because other consumers do care.
      if (event.guildId === null) return;

      const message = readMessage(event.payload);
      if (message === null) return;

      // Bots and webhooks earn nothing. A webhook post has no member behind it at
      // all, so there is nobody for the XP to belong to.
      if (message.isBot || message.isWebhook) return;
      if (!CONVERSATIONAL_MESSAGE_TYPES.has(message.type)) return;

      if (ctx.config.excludedChannelIds.includes(message.channelId)) return;
      if (excludedByRole(ctx.config, message.roleIds)) return;

      // Both bounds at zero is a guild switching message XP off while keeping
      // voice XP on. Nothing to award, and nothing worth a write.
      if (ctx.config.xpPerMessageMax <= 0 && ctx.config.xpPerMessageMin <= 0) return;

      const parsed = readSettings(ctx.config);
      if ('invalid' in parsed) {
        ctx.logger.error(parsed.invalid, { guildId: ctx.guildId, moduleId: MODULE_ID });
        return;
      }

      const bound = bindXp(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound('message XP', bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      const amount = rollMessageXp(ctx.config, deps.random);

      let result: Awaited<ReturnType<typeof bound.xp.award>>;
      try {
        result = await bound.xp.award({
          guildId: event.guildId,
          userId: message.authorId,
          amount,
          cooldownMs: parsed.settings.messageCooldownMs,
          // The message's own timestamp, never the clock: a bus backlog must not
          // compress a member's messages into one cooldown window, and a replayed
          // fixture must land where it originally did (I4).
          now: event.occurredAt,
        });
      } catch (error) {
        // Logged and swallowed rather than rethrown. A throw asks the bus to
        // redeliver, and for XP that trade is upside down: losing one award is
        // invisible, while a database blip that redelivers every message in the
        // guild five times is an outage for every module behind this one on the
        // stream. `phishing` makes the same call for the same reason.
        ctx.logger.error(
          `leveling could not record XP for ${message.authorId}: ${
            error instanceof Error ? error.message : String(error)
          }. If this says the guild row is missing, the guild has not been registered — ` +
            'GUILD_CREATE writes it, so a guild joined while the worker was down needs a ' +
            'reconnect before its members can earn XP.',
          { guildId: ctx.guildId, moduleId: MODULE_ID, userId: message.authorId },
        );
        return;
      }

      // Inside the cooldown window: not an error, not worth a log line. This is
      // the common case on a busy channel.
      if (!result.awarded) return;

      await applyLevelUp(ctx, {
        userId: message.authorId,
        previousLevel: result.previousLevel,
        level: result.level,
        xp: result.xp,
        source: 'message',
        // The event id, so however many times the message is delivered the
        // member is rewarded and announced once (I4).
        idempotencyRoot: `leveling:${event.id}`,
        originChannelId: message.channelId,
        ...(message.roleIds === null ? {} : { heldRoleIds: message.roleIds }),
      });
    },
  };
}

/**
 * Staff exclusions.
 *
 * When the dispatch carried no member object there is nothing to match against,
 * and the message is awarded rather than skipped — an unreadable fact is not
 * evidence of exclusion. In practice every guild message carries one.
 */
function excludedByRole(config: LevelingConfig, roleIds: string[] | null): boolean {
  if (roleIds === null || config.excludedRoleIds.length === 0) return false;
  return roleIds.some((roleId) => config.excludedRoleIds.includes(roleId));
}

/**
 * Note on threads: a message in a thread arrives with the *thread's* id as
 * `channel_id`, and the dispatch does not name the parent channel — so excluding
 * a channel does not exclude threads started inside it. Resolving the parent
 * would mean a REST call per message on the hottest path in the system, which is
 * not a trade worth making for a setting a guild can also apply to the thread.
 */
