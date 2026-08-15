import type { EventListener, EventType } from '@proton/core';
import { type LevelingConfig, readSettings, rollMessageXp } from './config.ts';
import { bindXp, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
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

      const amount = rollMessageXp(ctx.config, deps.random);

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

      await applyLevelUp(ctx, {
        userId: message.authorId,
        previousLevel: result.previousLevel,
        level: result.level,
        xp: result.xp,
        source: 'message',

        idempotencyRoot: `leveling:${event.id}`,
        originChannelId: message.channelId,
        ...(message.roleIds === null ? {} : { heldRoleIds: message.roleIds }),
      });
    },
  };
}

function excludedByRole(config: LevelingConfig, roleIds: string[] | null): boolean {
  if (roleIds === null || config.excludedRoleIds.length === 0) return false;
  return roleIds.some((roleId) => config.excludedRoleIds.includes(roleId));
}
