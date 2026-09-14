import type { EventListener, EventType } from '@proton/core';
import type { MemberFacts, UserFacts } from '@proton/core/placeholders';
import { type LevelingConfig, readSettings, rollMessageXp } from './config.ts';
import { bindXp, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { channelChainFor, xpEventsBetween } from './multiplier-lookup.ts';
import { messageXpCandidates, resolveXpMultiplier, scaleMessageXp } from './multipliers.ts';
import { MODULE_ID } from './perform.ts';

export const MESSAGE_XP_EVENT_TYPES: EventType[] = ['message.created'];

const CONVERSATIONAL_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19]);

export interface XpMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
  isWebhook: boolean;
  type: number;

  roleIds: string[] | null;
}

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

function own(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

function text(value: unknown, key: string): string | null {
  const held = own(value, key);
  return typeof held === 'string' ? held : null;
}

function nullableText(value: unknown, key: string): string | null | undefined {
  const held = own(value, key);
  if (typeof held === 'string') return held;
  return held === null ? null : undefined;
}

export interface AuthorFacts {
  user?: UserFacts | undefined;
  member?: MemberFacts | undefined;
}

export function readAuthorFacts(payload: unknown): AuthorFacts {
  const author = own(payload, 'author');
  const id = text(author, 'id');
  const member = own(payload, 'member');
  const roles = own(member, 'roles');

  return {
    user:
      id === null
        ? undefined
        : {
            id,
            username: text(author, 'username'),
            globalName: text(author, 'global_name'),
            avatarHash: text(author, 'avatar'),
            bot: own(author, 'bot') === true,
          },
    member:
      typeof member === 'object' && member !== null
        ? {
            nick: nullableText(member, 'nick'),
            joinedAt: nullableText(member, 'joined_at'),
            premiumSince: nullableText(member, 'premium_since'),
            roleIds: Array.isArray(roles)
              ? roles.filter((role): role is string => typeof role === 'string')
              : undefined,
          }
        : undefined,
  };
}

export function createMessageXpListener(deps: LevelingDeps): EventListener<LevelingConfig> {
  return {
    types: MESSAGE_XP_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      if (event.guildId === null) return;

      const message = readMessage(event.payload);
      if (message === null) return;

      if (message.isBot || message.isWebhook) return;
      if (!CONVERSATIONAL_MESSAGE_TYPES.has(message.type)) return;

      if (ctx.config.excludedChannelIds.includes(message.channelId)) return;
      if (excludedByRole(ctx.config, message.roleIds)) return;

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

      const rolled = rollMessageXp(ctx.config, deps.random);

      const multiplier = resolveXpMultiplier(
        messageXpCandidates(ctx.config, {
          guildId: event.guildId,
          roleIds: message.roleIds ?? [],
          channelChain: await channelChainFor(ctx, deps, event.guildId, message.channelId),
          events: await xpEventsBetween(
            ctx,
            deps,
            event.guildId,
            event.occurredAt,
            event.occurredAt + 1,
          ),
          at: event.occurredAt,
        }),
      );

      if (multiplier === 0) return;

      const amount = scaleMessageXp(rolled, multiplier);

      let result: Awaited<ReturnType<typeof bound.xp.award>>;
      try {
        result = await bound.xp.award({
          guildId: event.guildId,
          userId: message.authorId,
          amount,
          cooldownMs: parsed.settings.messageCooldownMs,

          now: event.occurredAt,
        });
      } catch (error) {
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

      if (!result.awarded) return;

      await applyLevelUp(
        ctx,
        {
          userId: message.authorId,
          previousLevel: result.previousLevel,
          level: result.level,
          xp: result.xp,
          source: 'message',

          idempotencyRoot: `leveling:${event.id}`,
          originChannelId: message.channelId,
          ...(message.roleIds === null ? {} : { heldRoleIds: message.roleIds }),
          gained: amount,
          ...readAuthorFacts(event.payload),
        },
        deps,
      );
    },
  };
}

function excludedByRole(config: LevelingConfig, roleIds: string[] | null): boolean {
  if (roleIds === null || config.excludedRoleIds.length === 0) return false;
  return roleIds.some((roleId) => config.excludedRoleIds.includes(roleId));
}
