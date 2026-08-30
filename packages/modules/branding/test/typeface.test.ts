import { describe, expect, test } from 'bun:test';
import {
  applyTypeface,
  fitsNickname,
  NICKNAME_MAX_UNITS,
  nicknameBudget,
  TYPEFACE_LABELS,
  TYPEFACES,
  type Typeface,
} from '../src/typeface.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

const STYLED = TYPEFACES.filter((face): face is Exclude<Typeface, 'none'> => face !== 'none');

describe('every typeface renders every letter', () => {
  // The whole reason small caps is not offered: one missing letter turns a "font" into a name that
  // silently changes shape depending on how it is spelled.
  test.each(STYLED)('%s has no gaps and no tofu across A-Z a-z', (face) => {
    const styled = applyTypeface(ALPHABET, face);
    const glyphs = [...styled];

    expect(glyphs).toHaveLength(ALPHABET.length);

    for (const [index, glyph] of glyphs.entries()) {
      const code = glyph.codePointAt(0) ?? 0;

      // Unchanged means the offset landed on a reserved codepoint and the letter fell through.
      expect(`${face}/${ALPHABET[index]}: ${glyph !== ALPHABET[index]}`).toBe(
        `${face}/${ALPHABET[index]}: true`,
      );

      // Every filled hole is a Letterlike Symbol; everything else is in its own block. Neither is
      // an unassigned codepoint.
      expect(code).toBeGreaterThan(0x2000);
    }
  });

  test.each(STYLED)('%s either styles all ten digits or leaves them ASCII', (face) => {
    const styled = [...applyTypeface(DIGITS, face)];
    const changed = styled.filter((glyph, index) => glyph !== DIGITS[index]);

    expect(`${face}: ${changed.length}`).toMatch(/: (0|10)$/);
  });

  test('leaves spaces and punctuation alone, so a two-word name stays two words', () => {
    expect([...applyTypeface('Dream Liner!', 'bold')].length).toBe(12);
    expect(applyTypeface('Dream Liner!', 'bold')).toContain(' ');
    expect(applyTypeface('Dream Liner!', 'bold')).toEndWith('!');
  });

  test('the default face changes nothing at all', () => {
    expect(applyTypeface('Dreamliner', 'none')).toBe('Dreamliner');
  });

  test('names every face it offers', () => {
    for (const face of TYPEFACES) expect(TYPEFACE_LABELS[face]).toBeTruthy();
  });
});

describe('the nickname budget', () => {
  test('astral faces cost two UTF-16 units a glyph, so the budget halves', () => {
    const bold = applyTypeface('ABCDEFGHIJKLMNOP', 'bold');

    expect([...bold]).toHaveLength(16);
    expect(bold.length).toBe(32);
    expect(fitsNickname(bold)).toBe(true);

    expect(nicknameBudget('bold')).toBe(16);
  });

  test('one glyph past the budget is refused rather than sent for Discord to reject', () => {
    expect(fitsNickname(applyTypeface('ABCDEFGHIJKLMNOPQ', 'bold'))).toBe(false);
  });

  test('the wide face stays in the BMP, so it keeps the whole 32', () => {
    const wide = applyTypeface('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'wide');

    expect(wide.length).toBe(NICKNAME_MAX_UNITS);
    expect(fitsNickname(wide)).toBe(true);
    expect(nicknameBudget('wide')).toBe(NICKNAME_MAX_UNITS);
  });

  test('an unstyled name keeps the whole 32', () => {
    expect(nicknameBudget('none')).toBe(NICKNAME_MAX_UNITS);
    expect(fitsNickname('A'.repeat(32))).toBe(true);
    expect(fitsNickname('A'.repeat(33))).toBe(false);
  });
});
