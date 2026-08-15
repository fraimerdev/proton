import type { RestProxyClient } from '@proton/core';
import type {
  BoardPostQuery,
  SourceMessage,
  SourceMessageRequest,
  StarboardDeps,
} from '@proton/module-starboard';
import { boardPostMatches, readSourceMessage } from '@proton/module-starboard';

const BOARD_LOOKBACK = 25;

export function createStarboardSource(
  rest: RestProxyClient,
  options: {
    onUnavailable?(what: string, status: number): void;
  } = {},
): Pick<StarboardDeps, 'readMessage' | 'resolveBoardPost'> {
  async function channelIsNsfw(channelId: string): Promise<boolean> {
    const response = await rest.request({ method: 'GET', path: `/channels/${channelId}` });
    if (response.status >= 400) {
      options.onUnavailable?.(`channel ${channelId}`, response.status);
      return false;
    }
    return (response.body as { nsfw?: boolean } | null)?.nsfw === true;
  }

  async function reactors(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<string[] | null> {
    const response = await rest.request({
      method: 'GET',
      path: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    });

    if (response.status >= 400) {
      options.onUnavailable?.(`reactions on message ${messageId}`, response.status);
      return null;
    }

    return Array.isArray(response.body)
      ? response.body
          .map((user) => (user as { id?: unknown }).id)
          .filter((id): id is string => typeof id === 'string')
      : null;
  }

  return {
    async readMessage(request: SourceMessageRequest): Promise<SourceMessage | null> {
      const response = await rest.request({
        method: 'GET',
        path: `/channels/${request.channelId}/messages/${request.messageId}`,
      });

      if (response.status >= 400) {
        options.onUnavailable?.(`message ${request.messageId}`, response.status);
        return null;
      }

      const [channelNsfw, starredBy] = await Promise.all([
        channelIsNsfw(request.channelId),
        request.withReactors
          ? reactors(request.channelId, request.messageId, request.emoji)
          : Promise.resolve(null),
      ]);

      return readSourceMessage(response.body, { channelNsfw, starredBy });
    },

    async resolveBoardPost(query: BoardPostQuery): Promise<string | null> {
      const response = await rest.request({
        method: 'GET',
        path: `/channels/${query.boardChannelId}/messages?limit=${BOARD_LOOKBACK}`,
      });

      if (response.status >= 400) {
        options.onUnavailable?.(`board channel ${query.boardChannelId}`, response.status);
        return null;
      }

      if (!Array.isArray(response.body)) return null;

      const match = response.body.find((message) => boardPostMatches(message, query.jumpUrl));
      const id = (match as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' ? id : null;
    },
  };
}
