import {
  type ContextMenuDefinition,
  errorStatus,
  isHumanMessage,
  messageUrl,
  Permissions,
  type ResolvedMessage,
} from '@proton/core';
import {
  ApplicationCommandType,
  InteractionContextType,
  InteractionType,
} from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { deferTo, replyTo, respondTo, send, statusMessage } from '../interactions/respond.ts';
import { startPunishFlow } from './flow.ts';
import { MODERATION_OFF } from './pending.ts';
import type { ProofMessage } from './types.ts';

export const PUNISH_AUTHOR_MENU = 'Punish author';

export const PUNISH_FROM_MESSAGE_OFF =
  'Punishing from a message is off in this server. To use it, turn on “Punish from a message” ' +
  'in the Proton dashboard under Moderation → Punish settings.';

type Menu = ContextMenuDefinition<ModerationConfig>;

function refusalFor(message: ResolvedMessage | undefined, invokerId: string): string | null {
  if (!message) return 'I couldn’t read that message, so nothing was done.';
  if (message.webhookId !== null) {
    return 'That message was sent by a webhook, so there’s no member to punish.';
  }
  if (!message.author || message.author.bot) return 'Bots can’t be punished from a message.';
  if (!isHumanMessage(message.type)) return 'System messages have no author to punish.';
  if (message.author.id === invokerId) return 'You can’t punish yourself.';
  return null;
}

function proofOf(guildId: string, message: ResolvedMessage, authorId: string): ProofMessage {
  return {
    channelId: message.channelId,
    messageId: message.id,
    authorId,
    content: message.content || message.snapshotContent || '',
    createdAt: message.createdAt,
    attachments: message.attachments,
    url: messageUrl(guildId, message.channelId, message.id),
  };
}

export function punishAuthorMenu(deps: ModerationDeps): Menu {
  return {
    name: PUNISH_AUTHOR_MENU,
    type: 'message',
    description: 'Punish the author of a message, keeping the message as proof.',
    data: {
      name: PUNISH_AUTHOR_MENU,
      type: ApplicationCommandType.Message,
      contexts: [InteractionContextType.Guild],
      default_member_permissions: String(Permissions.ModerateMembers),
    },

    async handler(ctx) {
      const to = respondTo(
        ctx.guildId,
        ctx.userId,
        {
          id: ctx.interaction.id,
          token: ctx.interaction.token,
          type: InteractionType.ApplicationCommand,
        },
        ctx.idempotencyKey,
      );
      const refuse = async (text: string) => {
        await send(ctx, replyTo(to, statusMessage(errorStatus(text))));
      };

      if (!ctx.config.enabled) return refuse(MODERATION_OFF);
      if (!ctx.config.punish.punishFromMessage) return refuse(PUNISH_FROM_MESSAGE_OFF);

      const message = ctx.resolved.messages.get(ctx.targetId);
      const refusal = refusalFor(message, ctx.userId);
      if (refusal || !message?.author) return refuse(refusal ?? 'That message has no author.');

      await send(ctx, deferTo(to, true));

      await startPunishFlow(
        ctx,
        deps,
        {
          interaction: to.interaction,
          applicationId: ctx.applicationId ?? null,
          actorId: ctx.userId,
          roleIds: ctx.actorRoleIds ?? null,
          permissions: ctx.actorPermissions ?? null,
          channelId: ctx.channelId,
          idempotencyKey: ctx.idempotencyKey,
        },
        {
          targetId: message.author.id,
          proof: proofOf(ctx.guildId, message, message.author.id),
          origin: { type: 'message' },
        },
      );
    },
  };
}
