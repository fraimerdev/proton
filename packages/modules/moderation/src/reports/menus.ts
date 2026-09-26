import { type ContextMenuDefinition, isHumanMessage } from '@proton/core';
import { ApplicationCommandType, InteractionContextType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { capturedMessage } from './evidence.ts';
import { intakeGate, refuseInvoker, startIntake } from './intake.ts';

export const REPORT_USER_MENU = 'Report user';
export const REPORT_MESSAGE_MENU = 'Report message';

type Menu = ContextMenuDefinition<ModerationConfig>;

export function reportUserMenu(deps: ModerationDeps): Menu {
  return {
    name: REPORT_USER_MENU,
    type: 'user',
    description: 'Report a member to this server’s staff.',
    data: {
      name: REPORT_USER_MENU,
      type: ApplicationCommandType.User,
      contexts: [InteractionContextType.Guild],
    },

    async handler(ctx) {
      const user = ctx.resolved.users.get(ctx.targetId);
      const member = ctx.resolved.members.get(ctx.targetId);

      return startIntake(ctx, deps, {
        method: 'user_menu',
        targetId: ctx.targetId,
        targetName: user?.username ?? null,
        targetBot: user?.bot ?? false,
        targetRoleIds: member ? member.roleIds : null,
        source: null,
        message: null,
        messageLink: null,
        attachment: null,
      });
    },
  };
}

export function reportMessageMenu(deps: ModerationDeps): Menu {
  return {
    name: REPORT_MESSAGE_MENU,
    type: 'message',
    description: 'Report a message to this server’s staff.',
    data: {
      name: REPORT_MESSAGE_MENU,
      type: ApplicationCommandType.Message,
      contexts: [InteractionContextType.Guild],
    },

    async handler(ctx) {
      const gate = intakeGate(ctx, 'message_menu');
      if (gate) return refuseInvoker(ctx, gate);

      const message = ctx.resolved.messages.get(ctx.targetId);
      if (!message) {
        return refuseInvoker(ctx, 'I couldn’t read that message, so nothing was filed.');
      }

      if (message.webhookId !== null) {
        return refuseInvoker(
          ctx,
          'Messages sent through a webhook can’t be reported, because there’s no member behind them.',
        );
      }

      const author = message.author;
      if (!author || author.bot) {
        return refuseInvoker(ctx, 'Messages from bots can’t be reported.');
      }

      if (!isHumanMessage(message.type)) {
        return refuseInvoker(ctx, 'System messages can’t be reported.');
      }

      if (author.id === ctx.userId) {
        return refuseInvoker(ctx, 'You can’t report your own message.');
      }

      return startIntake(ctx, deps, {
        method: 'message_menu',
        targetId: author.id,
        targetName: author.username,
        targetBot: false,
        targetRoleIds: null,
        source: { channelId: message.channelId, messageId: message.id, authorId: author.id },
        message: capturedMessage(message, ctx.guildId, 'interaction'),
        messageLink: null,
        attachment: null,
      });
    },
  };
}

export function reportMenus(deps: ModerationDeps): Menu[] {
  return [reportUserMenu(deps), reportMessageMenu(deps)];
}
