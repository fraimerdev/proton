import { isHumanMessage, type ProtonEvent } from '@proton/core';

export interface TrapMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  type: number;

  isBot: boolean;
  isWebhook: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readMessage(event: ProtonEvent): TrapMessage | null {
  const d = record(event.payload);
  const author = record(d?.author);
  if (!d || !author) return null;

  const messageId = str(d.id);
  const channelId = str(d.channel_id);
  const authorId = str(author.id);
  if (!messageId || !channelId || !authorId) return null;

  return {
    messageId,
    channelId,
    authorId,

    // Absent for an ordinary message, so this must default to 0 rather than refuse the message.
    type: typeof d.type === 'number' ? d.type : 0,

    // Discord omits author.bot for a human and omits webhook_id entirely off a webhook, so both
    // have to be read as presence, never as the negation of an absent field.
    isBot: author.bot === true,
    isWebhook: typeof d.webhook_id === 'string',
  };
}

export type IgnoreReason = 'self' | 'bot' | 'webhook' | 'system_message';

export function ignoreReason(message: TrapMessage, botUserId: string): IgnoreReason | null {
  // Not configurable. A honeypot that springs on Proton's own warning notice is a loop.
  if (message.authorId === botUserId) return 'self';

  if (message.isWebhook) return 'webhook';
  if (message.isBot) return 'bot';

  // A join announcement and a boost notice both carry the member as `author` with no bot flag, so
  // without this a honeypot that is also the system channel bans everyone who joins.
  if (!isHumanMessage(message.type)) return 'system_message';

  return null;
}
