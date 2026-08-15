import { describe, expect, test } from 'bun:test';
import {
  CARD_PRESETS,
  cardDescriptorSchema,
  monogram,
  PRESET_PALETTES,
  sanitiseText,
} from '../src/index.ts';

describe('sanitiseText', () => {
  test('keeps latin text unchanged', () => {
    expect(sanitiseText('Fraimer')).toBe('Fraimer');
    expect(sanitiseText('José Ñuñez')).toBe('José Ñuñez');
  });

  test('drops glyphs the embedded subset cannot draw', () => {
    // Otherwise satori emits .notdef and the card shows blanks where the name is.
    expect(sanitiseText('ユーザー名')).toBe('Member');
    expect(sanitiseText('cool 🎉 name')).toBe('cool name');
  });

  test('collapses whitespace so a name stays one line', () => {
    expect(sanitiseText('  a \n\t b  ')).toBe('a b');
  });

  test('falls back when nothing renderable survives', () => {
    expect(sanitiseText('🎉🎉')).toBe('Member');
    expect(sanitiseText('🎉', 'this server')).toBe('this server');
  });
});

describe('monogram', () => {
  test('takes the first renderable letter or digit, uppercased', () => {
    expect(monogram('fraimer')).toBe('F');
    expect(monogram('9lives')).toBe('9');
    expect(monogram('  José')).toBe('J');
  });

  test('skips leading punctuation, which Discord names are full of', () => {
    expect(monogram('!!!admin')).toBe('A');
  });

  test('falls back to ? rather than drawing an unrenderable glyph', () => {
    expect(monogram('🎉')).toBe('?');
    expect(monogram('ユーザー')).toBe('?');
  });
});

describe('presets', () => {
  test('every preset has a palette', () => {
    for (const preset of CARD_PRESETS) {
      expect(PRESET_PALETTES[preset]).toBeDefined();
    }
    // §13 ships three and rules out a custom editor; a fourth arriving silently
    // is a product decision that should not slip in as a refactor.
    expect(CARD_PRESETS).toHaveLength(3);
  });
});

describe('cardDescriptorSchema', () => {
  test('defaults the preset so a caller need not pick one', () => {
    const parsed = cardDescriptorSchema.parse({
      kind: 'welcome',
      displayName: 'a',
      guildName: 'g',
      memberCount: 0,
    });
    expect(parsed.preset).toBe('midnight');
  });

  test('refuses progress beyond the level span rather than clamping it', () => {
    const result = cardDescriptorSchema.safeParse({
      kind: 'rank',
      displayName: 'a',
      level: 1,
      totalXp: 10,
      xpIntoLevel: 100,
      xpForNextLevel: 10,
    });
    expect(result.success).toBe(false);
  });

  test('refuses an avatar URL that is not a URL', () => {
    const result = cardDescriptorSchema.safeParse({
      kind: 'welcome',
      displayName: 'a',
      guildName: 'g',
      memberCount: 0,
      avatarUrl: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });

  test('rank is optional, so a caller may skip the leaderboard query', () => {
    const parsed = cardDescriptorSchema.parse({
      kind: 'rank',
      displayName: 'a',
      level: 1,
      totalXp: 10,
      xpIntoLevel: 5,
      xpForNextLevel: 10,
    });
    expect(parsed.kind === 'rank' && parsed.rank).toBeUndefined();
  });
});
