import type { Logger, RestProxyClient } from '@proton/core';
import { type EmojiIds, type EmojiSet, emojiSet } from '@proton/module-serverlog';

interface ApplicationEmoji {
  id?: unknown;
  name?: unknown;
}

function idsOf(body: unknown): Set<string> {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return new Set();

  return new Set(
    items
      .map((item) => (item as ApplicationEmoji).id)
      .filter((id): id is string => typeof id === 'string'),
  );
}

export async function verifyApplicationEmojis(
  rest: RestProxyClient,
  applicationId: string,
  ids: EmojiIds,
  logger: Logger,
): Promise<EmojiSet> {
  if (!ids.stemId && !ids.replyId) return emojiSet();

  let owned: Set<string>;
  try {
    const response = await rest.request({
      method: 'GET',
      path: `/applications/${applicationId}/emojis`,
    });

    if (response.status >= 400) {
      logger.warn(
        `could not list this application's emojis (Discord answered ${response.status}), so the ` +
          'configured log emoji were used unverified. If logs render as broken emoji, check that ' +
          'PROTON_EMOJI_STEM and PROTON_EMOJI_REPLY are application emoji, not server emoji.',
      );
      return emojiSet(ids);
    }

    owned = idsOf(response.body);
  } catch (error) {
    logger.warn(
      `could not list this application's emojis (${
        error instanceof Error ? error.message : String(error)
      }), so the configured log emoji were used unverified.`,
    );
    return emojiSet(ids);
  }

  const checked: EmojiIds = {};

  for (const [name, id] of [
    ['PROTON_EMOJI_STEM', ids.stemId],
    ['PROTON_EMOJI_REPLY', ids.replyId],
  ] as const) {
    if (!id) continue;

    if (!owned.has(id)) {
      // A guild emoji renders as broken text in every other guild Proton is in, so one wrong id
      // degrades to a plain character rather than corrupting every log everywhere.
      logger.error(
        `${name}=${id} is not an emoji this application owns, so it would render as broken text ` +
          'in every server except the one that owns it. Upload it under your application’s ' +
          `Emojis tab and use the new id, or unset ${name} to fall back to a plain character.`,
      );
      continue;
    }

    if (name === 'PROTON_EMOJI_STEM') checked.stemId = id;
    else checked.replyId = id;
  }

  return emojiSet(checked);
}
