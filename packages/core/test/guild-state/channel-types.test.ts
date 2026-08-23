import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_TYPES,
  isThreadChannel,
  isThreadType,
} from '../../src/guild-state/channel-types.ts';

const THREADS: number[] = [
  CHANNEL_TYPES.announcementThread,
  CHANNEL_TYPES.publicThread,
  CHANNEL_TYPES.privateThread,
];

describe('which Discord channel types are threads', () => {
  test.each(THREADS)('type %i is a thread', (type) => {
    expect(isThreadType(type)).toBe(true);
  });

  test.each(Object.values(CHANNEL_TYPES).filter((type) => !THREADS.includes(type)))(
    'type %i is not a thread',
    (type) => {
      expect(isThreadType(type)).toBe(false);
    },
  );

  test('a type Discord has not shipped yet is not a thread, rather than a crash', () => {
    expect(isThreadType(99)).toBe(false);
  });
});

describe('asking a cached channel whether it is a thread', () => {
  test('a channel that never recorded its type is not claimed to be a thread', () => {
    expect(isThreadChannel({ id: '1', parentId: null, overwrites: [] })).toBe(false);
  });

  test('a channel guild state has never seen is not claimed to be a thread', () => {
    expect(isThreadChannel(undefined)).toBe(false);
  });

  test('a thread is', () => {
    expect(
      isThreadChannel({
        id: '1',
        parentId: '2',
        type: CHANNEL_TYPES.privateThread,
        overwrites: [],
      }),
    ).toBe(true);
  });
});
