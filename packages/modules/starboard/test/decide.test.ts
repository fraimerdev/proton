import { describe, expect, test } from 'bun:test';
import { starboardConfigSchema } from '../src/config.ts';
import { countStars, decide, eligibility } from '../src/decide.ts';
import type { EmojiRef, SourceMessage } from '../src/source.ts';

const BOARD = '500000000000000009';
const SOURCE = '500000000000000001';
const AUTHOR = '100000000000000001';
const STARRER = '100000000000000002';

const STAR: EmojiRef = { id: null, name: '⭐' };

function config(overrides: Record<string, unknown> = {}) {
  return starboardConfigSchema.parse({
    enabled: true,
    boardChannelId: BOARD,
    threshold: 3,
    ...overrides,
  });
}

function message(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    id: '1400000000000000001',
    channelId: SOURCE,
    authorId: AUTHOR,
    authorBot: false,
    authorName: 'Tester',
    authorAvatarUrl: null,
    content: 'hello',
    attachments: [],
    reactions: [{ emoji: STAR, count: 3 }],
    channelNsfw: false,
    starredBy: null,
    ...overrides,
  } as SourceMessage;
}

/**
 * The loop guard first, because it is the only failure here that is unbounded.
 * A board that stars its own posts produces a post per post, forever.
 */
describe('eligibility', () => {
  test('never stars a message already in the board channel', () => {
    const result = eligibility(message({ channelId: BOARD }), config(), BOARD);

    expect(result).toEqual({ eligible: false, reason: 'board_channel' });
  });

  test('an empty source list means every channel is a source', () => {
    expect(eligibility(message(), config({ sourceChannelIds: [] }), BOARD).eligible).toBe(true);
  });

  test('a configured source list excludes everything else', () => {
    const result = eligibility(
      message(),
      config({ sourceChannelIds: ['500000000000000099'] }),
      BOARD,
    );

    expect(result).toEqual({ eligible: false, reason: 'not_a_source_channel' });
  });

  test('bots are excluded only when the guild asks', () => {
    const bot = message({ authorBot: true });

    expect(eligibility(bot, config({ ignoreBots: true }), BOARD).eligible).toBe(false);
    expect(eligibility(bot, config({ ignoreBots: false }), BOARD).eligible).toBe(true);
  });

  test('nsfw channels are excluded only when the guild asks', () => {
    const nsfw = message({ channelNsfw: true });

    expect(eligibility(nsfw, config({ ignoreNsfw: true }), BOARD).eligible).toBe(false);
    expect(eligibility(nsfw, config({ ignoreNsfw: false }), BOARD).eligible).toBe(true);
  });

  test('the loop guard beats every other rule', () => {
    // A bot posting in the board channel with bots allowed: still refused.
    const result = eligibility(
      message({ channelId: BOARD, authorBot: true }),
      config({ ignoreBots: false }),
      BOARD,
    );

    expect(result).toEqual({ eligible: false, reason: 'board_channel' });
  });
});

describe('countStars', () => {
  test('counts the configured emoji and ignores others', () => {
    const mixed = message({
      reactions: [
        { emoji: { id: null, name: '🎉' }, count: 10 },
        { emoji: STAR, count: 4 },
      ],
    });

    expect(countStars(mixed, config({ selfStarAllowed: true }), STAR).count).toBe(4);
  });

  test('counts zero when the emoji is absent', () => {
    const none = message({ reactions: [] });

    expect(countStars(none, config(), STAR).count).toBe(0);
  });

  test('a self-star is discounted when the reactor list is known', () => {
    const selfStarred = message({ starredBy: [AUTHOR, STARRER] });
    const result = countStars(selfStarred, config({ selfStarAllowed: false }), STAR);

    expect(result.count).toBe(2);
    expect(result.total).toBe(3);
    expect(result.selfStarUnresolved).toBe(false);
  });

  test('someone else’s star is not discounted', () => {
    const result = countStars(
      message({ starredBy: [STARRER] }),
      config({ selfStarAllowed: false }),
      STAR,
    );

    expect(result.count).toBe(3);
  });

  test('self-stars are kept when the guild permits them', () => {
    const result = countStars(
      message({ starredBy: [AUTHOR] }),
      config({ selfStarAllowed: true }),
      STAR,
    );

    expect(result.count).toBe(3);
    expect(result.selfStarUnresolved).toBe(false);
  });

  /**
   * The guild barred self-stars but nobody fetched the reactor list, so the
   * author's own star may be inflating the count. Flagged rather than silently
   * tolerated — an off-by-one threshold nothing mentions is exactly the "the bot
   * did nothing I asked" failure §1 exists to kill.
   */
  test('an unresolved reactor list is reported, not hidden', () => {
    const result = countStars(
      message({ starredBy: null }),
      config({ selfStarAllowed: false }),
      STAR,
    );

    expect(result.selfStarUnresolved).toBe(true);
    expect(result.count).toBe(3);
  });

  test('nothing to be unresolved about at zero stars', () => {
    const result = countStars(
      message({ reactions: [], starredBy: null }),
      config({ selfStarAllowed: false }),
      STAR,
    );

    expect(result.selfStarUnresolved).toBe(false);
  });

  /**
   * `starredBy` and `reactions[].count` are two reads of a live message and can
   * disagree by one when a reaction lands between them. A negative star count
   * would render as "-1 ⭐".
   */
  test('the self-star subtraction never goes negative', () => {
    const racy = message({ reactions: [{ emoji: STAR, count: 0 }], starredBy: [AUTHOR] });

    expect(countStars(racy, config({ selfStarAllowed: false }), STAR).count).toBe(0);
  });
});

/**
 * All four transitions, plus the two no-ops. This is the whole state machine:
 * every reaction recomputes the count and re-enters here, so a wrong answer in
 * any cell is a board that drifts from reality and stays drifted.
 */
describe('decide', () => {
  test('at the threshold with no post, creates', () => {
    expect(decide({ count: 3, threshold: 3, post: null })).toEqual({ action: 'create', count: 3 });
  });

  test('above the threshold with a stale count, edits', () => {
    expect(
      decide({ count: 5, threshold: 3, post: { boardMessageId: 'm1', starCount: 4 } }),
    ).toEqual({ action: 'edit', boardMessageId: 'm1', count: 5 });
  });

  /** An unchanged count must cost no REST call, or every reaction re-edits. */
  test('an unchanged count does nothing', () => {
    expect(
      decide({ count: 4, threshold: 3, post: { boardMessageId: 'm1', starCount: 4 } }),
    ).toEqual({ action: 'none', reason: 'unchanged' });
  });

  test('falling below the threshold retracts the post', () => {
    expect(
      decide({ count: 2, threshold: 3, post: { boardMessageId: 'm1', starCount: 3 } }),
    ).toEqual({ action: 'delete', boardMessageId: 'm1' });
  });

  test('below the threshold with no post does nothing', () => {
    expect(decide({ count: 1, threshold: 3, post: null })).toEqual({
      action: 'none',
      reason: 'below_threshold',
    });
  });

  test('the threshold is inclusive — exactly N stars posts', () => {
    expect(decide({ count: 3, threshold: 3, post: null }).action).toBe('create');
    expect(decide({ count: 2, threshold: 3, post: null }).action).toBe('none');
  });

  test('an edit down is still an edit, not a delete, while above the threshold', () => {
    expect(
      decide({ count: 3, threshold: 3, post: { boardMessageId: 'm1', starCount: 9 } }),
    ).toEqual({ action: 'edit', boardMessageId: 'm1', count: 3 });
  });

  /**
   * The decision is a pure function of the recomputed count, which is what makes
   * a redelivered reaction harmless: the same message yields the same count
   * yields the same decision.
   */
  test('the same state always yields the same decision', () => {
    const state = { count: 5, threshold: 3, post: { boardMessageId: 'm1', starCount: 4 } };

    expect(decide(state)).toEqual(decide(state));
  });
});
