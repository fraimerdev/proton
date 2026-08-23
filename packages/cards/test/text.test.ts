import { describe, expect, test } from 'bun:test';
import {
  abbreviate,
  CARD_PRESETS,
  cardDescriptorSchema,
  monogram,
  PRESET_PALETTES,
  sanitiseText,
  toHexColour,
} from '../src/index.ts';

describe('sanitiseText', () => {
  test('keeps latin text unchanged', () => {
    expect(sanitiseText('Fraimer')).toBe('Fraimer');
    expect(sanitiseText('José Ñuñez')).toBe('José Ñuñez');
  });

  test('drops glyphs the embedded subset cannot draw', () => {
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

describe('abbreviate', () => {
  test('leaves a rank that fits alone', () => {
    expect(abbreviate(1)).toBe('1');
    expect(abbreviate(999)).toBe('999');
  });

  test('shortens the ones that would run into the card edge', () => {
    expect(abbreviate(1_200)).toBe('1.2k');
    expect(abbreviate(12_000)).toBe('12k');
    expect(abbreviate(3_400_000)).toBe('3.4m');
  });

  test('drops a trailing .0, which reads as noise', () => {
    expect(abbreviate(2_000)).toBe('2k');
  });
});

describe('presets', () => {
  test('every preset has a palette', () => {
    for (const preset of CARD_PRESETS) {
      expect(PRESET_PALETTES[preset]).toBeDefined();
    }

    expect(CARD_PRESETS).toHaveLength(3);
  });

  test('a Discord colour integer becomes a canvas hex string', () => {
    expect(toHexColour(0x5865f2)).toBe('#5865f2');
    expect(toHexColour(0)).toBe('#000000');
    expect(toHexColour(0xffffff)).toBe('#ffffff');
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
