export const TYPEFACES = [
  'none',
  'bold',
  'italic',
  'script',
  'fraktur',
  'outline',
  'mono',
  'wide',
] as const;

export type Typeface = (typeof TYPEFACES)[number];

export function isTypeface(value: string): value is Typeface {
  return (TYPEFACES as readonly string[]).includes(value);
}

export const TYPEFACE_LABELS: Record<Typeface, string> = {
  none: 'Default',
  bold: 'Bold',
  italic: 'Italic',
  script: 'Script',
  fraktur: 'Fraktur',
  outline: 'Outline',
  mono: 'Monospace',
  wide: 'Wide',
};

interface Face {
  upper: number;
  lower: number;

  // Absent where Unicode has no digit variant for the face. The digits stay ASCII rather than being
  // dropped or borrowed from a face that does not match.
  digit?: number;

  // Unicode punched holes in the Mathematical Alphanumeric blocks wherever a Letterlike Symbol
  // already carried the glyph, so a plain offset renders a reserved codepoint as tofu. Every hole
  // is filled here, which is why there is no small-caps face: its letters are scattered across
  // three unrelated blocks and X does not exist at all.
  holes?: Record<string, number>;
}

const FACES: Record<Exclude<Typeface, 'none'>, Face> = {
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },

  italic: { upper: 0x1d434, lower: 0x1d44e, holes: { h: 0x210e } },

  script: {
    upper: 0x1d49c,
    lower: 0x1d4b6,
    holes: {
      B: 0x212c,
      E: 0x2130,
      F: 0x2131,
      H: 0x210b,
      I: 0x2110,
      L: 0x2112,
      M: 0x2133,
      R: 0x211b,
      e: 0x212f,
      g: 0x210a,
      o: 0x2134,
    },
  },

  fraktur: {
    upper: 0x1d504,
    lower: 0x1d51e,
    holes: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
  },

  outline: {
    upper: 0x1d538,
    lower: 0x1d552,
    digit: 0x1d7d8,
    holes: {
      C: 0x2102,
      H: 0x210d,
      N: 0x2115,
      P: 0x2119,
      Q: 0x211a,
      R: 0x211d,
      Z: 0x2124,
    },
  },

  mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },

  // The only face that stays in the BMP, so its glyphs cost one UTF-16 unit each and a wide
  // nickname keeps all 32 characters where every other face keeps 16.
  wide: { upper: 0xff21, lower: 0xff41, digit: 0xff10 },
};

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const ZERO = 0x30;
const NINE = 0x39;

function styleChar(char: string, face: Face): string {
  const hole = face.holes?.[char];
  if (hole !== undefined) return String.fromCodePoint(hole);

  const code = char.codePointAt(0);
  if (code === undefined) return char;

  if (code >= UPPER_A && code <= UPPER_Z) {
    return String.fromCodePoint(face.upper + (code - UPPER_A));
  }
  if (code >= LOWER_A && code <= LOWER_Z) {
    return String.fromCodePoint(face.lower + (code - LOWER_A));
  }
  if (face.digit !== undefined && code >= ZERO && code <= NINE) {
    return String.fromCodePoint(face.digit + (code - ZERO));
  }

  return char;
}

export function applyTypeface(name: string, typeface: Typeface): string {
  if (typeface === 'none') return name;

  const face = FACES[typeface];

  return [...name].map((char) => styleChar(char, face)).join('');
}

export const NICKNAME_MAX_UNITS = 32;

// Discord counts "32 characters" without saying which unit, and an astral glyph is two UTF-16
// units. Measuring the styled string in the stricter unit is what stops a name that looked
// in-budget in the box coming back a 400 nobody can read.
export function fitsNickname(styled: string): boolean {
  return styled.length <= NICKNAME_MAX_UNITS && [...styled].length <= NICKNAME_MAX_UNITS;
}

export function nicknameBudget(typeface: Typeface): number {
  if (typeface === 'none' || typeface === 'wide') return NICKNAME_MAX_UNITS;
  return NICKNAME_MAX_UNITS / 2;
}
