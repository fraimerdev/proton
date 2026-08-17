import { describe, expect, test } from 'bun:test';
import {
  type CachedMessage,
  clampCacheTtl,
  MESSAGE_CACHE_CONTENT_MAX,
  MESSAGE_CACHE_MAX_TTL_MS,
  MESSAGE_CACHE_MIN_TTL_MS,
  toCachedMessage,
} from '../../src/messages/content-cache.ts';

const AUTHOR = '100000000000000002';
const CHANNEL = '500000000000000001';

const payload = {
  id: '1400000000000000001',
  channel_id: CHANNEL,
  guild_id: '900000000000000001',
  author: { id: AUTHOR, username: 'writer', bot: false },
  content: 'hello there',
  timestamp: '2026-08-16T12:00:00.000Z',
  attachments: [{ filename: 'shot.png', url: 'https://cdn.discordapp.com/x/shot.png' }],
};

describe('clampCacheTtl', () => {
  test('an hour is the floor', () => {
    expect(clampCacheTtl(1)).toBe(MESSAGE_CACHE_MIN_TTL_MS);
  });

  test('a week is the ceiling', () => {
    expect(clampCacheTtl(365 * 24 * 60 * 60 * 1000)).toBe(MESSAGE_CACHE_MAX_TTL_MS);
  });

  test('a value in range is kept', () => {
    expect(clampCacheTtl(24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('toCachedMessage', () => {
  test('keeps what a delete or edit log needs', () => {
    const cached = toCachedMessage(payload) as CachedMessage;

    expect(cached.authorId).toBe(AUTHOR);
    expect(cached.channelId).toBe(CHANNEL);
    expect(cached.content).toBe('hello there');
    expect(cached.createdAt).toBe(Date.parse('2026-08-16T12:00:00.000Z'));
  });

  test('records a bot author as a bot', () => {
    const cached = toCachedMessage({
      ...payload,
      author: { id: AUTHOR, username: 'helper', bot: true },
    });

    expect(cached?.authorBot).toBe(true);
  });

  test('keeps attachment names and links, never bytes', () => {
    const cached = toCachedMessage(payload) as CachedMessage;

    expect(cached.attachments).toEqual([
      { filename: 'shot.png', url: 'https://cdn.discordapp.com/x/shot.png' },
    ]);
    expect(JSON.stringify(cached)).not.toContain('data:');
  });

  test('an empty message still caches, so a delete log can say it was empty', () => {
    const cached = toCachedMessage({ ...payload, content: '' });

    expect(cached?.content).toBe('');
  });

  test('absurd content is capped', () => {
    const cached = toCachedMessage({ ...payload, content: 'x'.repeat(9000) });

    expect(cached?.content.length).toBe(MESSAGE_CACHE_CONTENT_MAX);
  });

  test('more than ten attachments are cut', () => {
    const cached = toCachedMessage({
      ...payload,
      attachments: Array.from({ length: 30 }, (_, i) => ({ filename: `${i}.png`, url: 'u' })),
    });

    expect(cached?.attachments).toHaveLength(10);
  });

  test('a payload with no usable author is refused rather than half-stored', () => {
    expect(toCachedMessage({ ...payload, author: {} })).toBeNull();
    expect(toCachedMessage(null)).toBeNull();
    expect(toCachedMessage({ ...payload, channel_id: 'nope' })).toBeNull();
  });

  test('a missing timestamp does not break the cache entry', () => {
    const cached = toCachedMessage({ ...payload, timestamp: undefined });

    expect(cached?.createdAt).toBe(0);
  });
});
