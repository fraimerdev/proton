import { describe, expect, test } from 'bun:test';
import {
  NAME_STYLE_OUTCOMES,
  NAME_STYLE_REASONS,
  nameStyleAttemptSchema,
  nameStyleStateSchema,
} from '../../src/branding/name-style-state.ts';

const GUILD = '1450209710199279760';
const MODERN_GRADIENT = { fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] };

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guildId: GUILD,
    requested: MODERN_GRADIENT,
    outcome: 'confirmed',
    reason: null,
    attemptedAt: 1_787_000_000_000,
    confirmed: MODERN_GRADIENT,
    confirmedAt: 1_787_000_000_000,
    updatedAt: 1_787_000_000_000,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guildId: GUILD,
    requested: MODERN_GRADIENT,
    outcome: 'ignored',
    reason: 'discord_ignored',
    at: 1_787_000_000_000,
    ...overrides,
  };
}

describe('the outcome and reason vocabularies', () => {
  test('name exactly the four outcomes a style attempt can end in', () => {
    expect([...NAME_STYLE_OUTCOMES]).toEqual(['confirmed', 'ignored', 'rejected', 'unverified']);
  });

  test('name exactly the six customer-safe reasons', () => {
    expect([...NAME_STYLE_REASONS]).toEqual([
      'missing_change_nickname',
      'discord_refused',
      'discord_ignored',
      'no_answer',
      'not_readable',
      'changed_in_discord',
    ]);
  });
});

describe('nameStyleStateSchema', () => {
  test('round-trips a confirmed style', () => {
    expect<unknown>(nameStyleStateSchema.parse(state())).toEqual(state());
  });

  test('round-trips a confirmed reset, where confirmed is null but confirmedAt is set', () => {
    const reset = state({ requested: null, confirmed: null });

    expect<unknown>(nameStyleStateSchema.parse(reset)).toEqual(reset);
  });

  test('round-trips a style that was observed but never attempted', () => {
    const observed = state({ attemptedAt: null });

    expect<unknown>(nameStyleStateSchema.parse(observed)).toEqual(observed);
  });

  test('round-trips a failed attempt that left nothing confirmed', () => {
    const failed = state({
      outcome: 'rejected',
      reason: 'missing_change_nickname',
      confirmed: null,
      confirmedAt: null,
    });

    expect<unknown>(nameStyleStateSchema.parse(failed)).toEqual(failed);
  });

  test.each([
    ['an unknown outcome', { outcome: 'applied' }],
    ['an unknown reason', { reason: 'timeout' }],
    ['a guild id that is not a snowflake', { guildId: 'guild' }],
    ['a fractional timestamp', { attemptedAt: 1.5 }],
    ['a colour past 0xffffff', { requested: { ...MODERN_GRADIENT, colours: [0x1000000] } }],
    ['a style with no colours', { requested: { ...MODERN_GRADIENT, colours: [] } }],
    ['a confirmed style with font id 0', { confirmed: { ...MODERN_GRADIENT, fontId: 0 } }],
    ['a missing updatedAt', { updatedAt: undefined }],
  ])('refuses %s', (_, overrides) => {
    expect(nameStyleStateSchema.safeParse(state(overrides)).success).toBe(false);
  });
});

describe('nameStyleAttemptSchema', () => {
  test('round-trips an attempt and a reset attempt', () => {
    expect<unknown>(nameStyleAttemptSchema.parse(attempt())).toEqual(attempt());

    const reset = attempt({ requested: null, outcome: 'confirmed', reason: null });
    expect<unknown>(nameStyleAttemptSchema.parse(reset)).toEqual(reset);
  });

  test('accepts colour 0 and 0xffffff, and refuses 0x1000000', () => {
    const edges = { ...MODERN_GRADIENT, colours: [0, 0xffffff] };

    expect(nameStyleAttemptSchema.safeParse(attempt({ requested: edges })).success).toBe(true);
    expect(
      nameStyleAttemptSchema.safeParse(
        attempt({ requested: { ...MODERN_GRADIENT, colours: [0x1000000] } }),
      ).success,
    ).toBe(false);
  });

  test('refuses an absent reason, because none is written as null', () => {
    expect(nameStyleAttemptSchema.safeParse(attempt({ reason: undefined })).success).toBe(false);
  });

  test('refuses an absent requested style, because the reset is written as null', () => {
    expect(nameStyleAttemptSchema.safeParse(attempt({ requested: undefined })).success).toBe(false);
  });
});
