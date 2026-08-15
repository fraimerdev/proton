import type { RestProxyClient } from '@proton/core';
import type {
  BoardPostQuery,
  SourceMessage,
  SourceMessageRequest,
  StarboardDeps,
} from '@proton/module-starboard';
import { boardPostMatches, readSourceMessage } from '@proton/module-starboard';

/**
 * How many recent board posts to look through when recovering an id.
 *
 * Board posts are appended in order, so the one just sent is at the end. Twenty
 * five is one page of Discord's default and covers any plausible interleaving
 * with other traffic in a board channel; a post older than that has almost
 * certainly already been recorded, and one that has not is repaired on the next
 * reaction rather than by scanning the channel's history.
 */
const BOARD_LOOKBACK = 25;

/**
 * The two REST-shaped ports starboard declares, bound to the proxy (I2).
 *
 * They live here rather than in the module for the reason every REST-touching
 * port does: a module may not hold a client against discord.com, so the module
 * describes the question and the process that owns the proxy answers it. The
 * *mapping* from Discord's message shape to the module's `SourceMessage` stays in
 * the module — `readSourceMessage` is exported for exactly this — so the only
 * thing here is the call.
 */
export function createStarboardSource(
  rest: RestProxyClient,
  options: {
    onUnavailable?(what: string, status: number): void;
  } = {},
): Pick<StarboardDeps, 'readMessage' | 'resolveBoardPost'> {
  /**
   * Whether the channel is age-restricted.
   *
   * Discord's message object carries no `nsfw` field (verified against the
   * message resource reference), so it comes from the channel — one extra call,
   * made only because `ignoreNsfw` exists. A channel we cannot read is reported
   * as not-NSFW, which is the permissive answer: the alternative is silently
   * refusing to star anything in a channel whose metadata happened to be
   * unreadable, and that failure looks exactly like the feature being broken.
   */
  async function channelIsNsfw(channelId: string): Promise<boolean> {
    const response = await rest.request({ method: 'GET', path: `/channels/${channelId}` });
    if (response.status >= 400) {
      options.onUnavailable?.(`channel ${channelId}`, response.status);
      return false;
    }
    return (response.body as { nsfw?: boolean } | null)?.nsfw === true;
  }

  /**
   * Who reacted with this emoji.
   *
   * A second endpoint, because the reaction object Discord returns on a message
   * carries counts and names nobody. Only fetched when a guild bars self-stars —
   * every other configuration gets `null`, which the module reads as "not
   * resolved" rather than "nobody".
   */
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
        /**
         * Null, never zero. A message that could not be read is not a message
         * with no stars — and the module treats the difference as load-bearing,
         * because "zero" would take a board post down for a message that is
         * still there and still starred.
         */
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

      // The module owns the rule for recognising its own post, so that the way
      // one is built and the way one is found cannot drift apart.
      const match = response.body.find((message) => boardPostMatches(message, query.jumpUrl));
      const id = (match as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' ? id : null;
    },
  };
}
