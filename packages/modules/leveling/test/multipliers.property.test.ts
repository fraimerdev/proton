import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  channelChain,
  resolveXpMultiplier,
  scaleMessageXp,
  type VoicePayoutInput,
  voiceXpPayout,
} from '../src/multipliers.ts';

const multiplier = fc.integer({ min: 0, max: 50 }).map((tenths) => tenths / 10);
const candidates = fc.array(multiplier, { maxLength: 12 });

const MINUTE_MS = 60_000;

const positiveSession = fc
  .record({
    minutes: fc.integer({ min: 1, max: 5 }),
    voiceXpPerMinute: fc.integer({ min: 1, max: 3 }),
    staticTenths: fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 3 }),
    windows: fc.array(
      fc.record({
        startMinute: fc.integer({ min: -10, max: 5 }),
        minutes: fc.integer({ min: 10, max: 30 }),
        tenths: fc.integer({ min: 1, max: 10 }),
      }),
      { maxLength: 3 },
    ),
  })
  .map(
    (raw): VoicePayoutInput => ({
      joinedAt: 0,
      minutes: raw.minutes,
      voiceXpPerMinute: raw.voiceXpPerMinute,
      staticCandidates: raw.staticTenths.map((tenths) => tenths / 10),
      events: raw.windows.map((window) => ({
        multiplier: window.tenths / 10,
        startsAt: window.startMinute * MINUTE_MS,
        endsAt: (window.startMinute + window.minutes) * MINUTE_MS,
      })),
    }),
  );

describe('voiceXpPayout', () => {
  test('never pays less than 1 for a session where no multiplier is 0', () => {
    fc.assert(
      fc.property(positiveSession, (input) => {
        expect(voiceXpPayout(input)).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  test('a static 0 pays nothing, whatever events run', () => {
    fc.assert(
      fc.property(positiveSession, (input) => {
        const blocked = { ...input, staticCandidates: [...input.staticCandidates, 0] };
        expect(voiceXpPayout(blocked)).toBe(0);
      }),
    );
  });
});

describe('resolveXpMultiplier', () => {
  test('no candidates leaves XP untouched', () => {
    expect(resolveXpMultiplier([])).toBe(1);
  });

  test('the highest candidate wins', () => {
    expect(resolveXpMultiplier([1.5, 3, 0.5])).toBe(3);
  });

  test('a single candidate below 1 still applies', () => {
    expect(resolveXpMultiplier([0.5])).toBe(0.5);
  });

  test('the result is one of the candidates, or 1 when there are none', () => {
    fc.assert(
      fc.property(candidates, (list) => {
        const result = resolveXpMultiplier(list);
        expect(list.length === 0 ? result === 1 : list.includes(result)).toBe(true);
      }),
    );
  });

  test('any 0 blocks XP whatever else applies', () => {
    fc.assert(
      fc.property(candidates, candidates, (before, after) => {
        expect(resolveXpMultiplier([...before, 0, ...after])).toBe(0);
      }),
    );
  });

  test('the order candidates are collected in does not matter', () => {
    fc.assert(
      fc.property(
        candidates.chain((list) =>
          fc.tuple(
            fc.constant(list),
            fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
          ),
        ),
        ([list, shuffled]) => {
          expect(resolveXpMultiplier(shuffled)).toBe(resolveXpMultiplier(list));
        },
      ),
    );
  });

  test('adding a lower non-zero candidate never changes the result', () => {
    fc.assert(
      fc.property(
        fc.array(multiplier, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 50 }),
        (list, tenths) => {
          const lower = Math.min(tenths / 10, Math.max(...list));
          fc.pre(lower > 0);

          expect(resolveXpMultiplier([...list, lower])).toBe(resolveXpMultiplier(list));
        },
      ),
    );
  });
});

describe('channelChain', () => {
  const channels = new Map([
    ['thread', { parentId: 'channel' }],
    ['channel', { parentId: 'category' }],
    ['category', { parentId: null }],
    ['loose', { parentId: null }],
  ]);

  test('a thread reaches its parent channel and that channel’s category', () => {
    expect(channelChain('thread', channels)).toEqual(['thread', 'channel', 'category']);
  });

  test('a channel reaches its category', () => {
    expect(channelChain('channel', channels)).toEqual(['channel', 'category']);
  });

  test('an unknown channel, or no guild state at all, is only itself', () => {
    expect(channelChain('missing', channels)).toEqual(['missing']);
    expect(channelChain('thread', undefined)).toEqual(['thread']);
  });

  test('a parent loop cannot repeat an id', () => {
    const looped = new Map([
      ['a', { parentId: 'b' }],
      ['b', { parentId: 'a' }],
    ]);

    expect(channelChain('a', looped)).toEqual(['a', 'b']);
  });
});

describe('scaleMessageXp', () => {
  test('rounds once, to the nearest whole XP', () => {
    expect(scaleMessageXp(15, 1.5)).toBe(23);
    expect(scaleMessageXp(10, 0.3)).toBe(3);
  });

  test('a multiplier that shrinks XP to nothing still pays 1', () => {
    expect(scaleMessageXp(3, 0.1)).toBe(1);
  });

  test('0 pays nothing', () => {
    expect(scaleMessageXp(25, 0)).toBe(0);
  });

  test('a roll of 0 stays 0 rather than being lifted to 1', () => {
    expect(scaleMessageXp(0, 2)).toBe(0);
  });

  test('never pays less than 1 for a positive roll and a positive multiplier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 50 }),
        (rolled, t) => {
          expect(scaleMessageXp(rolled, t / 10)).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });
});
