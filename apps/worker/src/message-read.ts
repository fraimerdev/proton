import { type RestProxyClient, toResolvedMessage, upstreamRefusal } from '@proton/core';
import type { MessageRead } from '@proton/module-moderation';

export function readMessageResponse(status: number, body: unknown): MessageRead {
  if (status >= 200 && status < 300) {
    const message = toResolvedMessage(body);
    return message ? { ok: true, message } : { ok: false, reason: 'failed' };
  }

  const refusal = upstreamRefusal(status);
  if (refusal === 'not_found') return { ok: false, reason: 'not_found' };
  if (refusal === 'forbidden') return { ok: false, reason: 'no_access' };
  return { ok: false, reason: 'failed' };
}

export function createMessageReader(
  rest: RestProxyClient,
): (guildId: string, channelId: string, messageId: string) => Promise<MessageRead> {
  return async (_guildId, channelId, messageId) => {
    try {
      const response = await rest.request({
        method: 'GET',
        path: `/channels/${channelId}/messages/${messageId}`,
      });
      return readMessageResponse(response.status, response.body);
    } catch {
      return { ok: false, reason: 'failed' };
    }
  };
}
