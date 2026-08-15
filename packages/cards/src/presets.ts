/**
 * The three card presets (PLAN.md §13).
 *
 * Three, and no custom card editor — §13 rules one out in as many words. That is
 * a product decision with a rendering consequence worth stating: because the
 * palette space is closed, every colour a card can contain is in this file, so a
 * contrast regression is caught by reading one table rather than by rendering a
 * guild's arbitrary hex codes and hoping. An editor would also turn `renderCard`
 * into an evaluator of untrusted layout, which is a different security posture
 * than rendering a fixed template with untrusted *strings* in it.
 */
export const CARD_PRESETS = ['midnight', 'aurora', 'parchment'] as const;

export type CardPreset = (typeof CARD_PRESETS)[number];

export interface PresetPalette {
  /** The card's outermost fill. */
  background: string;
  /** Raised areas — the progress track, the member-count pill. */
  surface: string;
  /** Primary type. Must clear 4.5:1 against `background`. */
  text: string;
  /** Secondary type. Must clear 3:1 against `background`. */
  muted: string;
  /** The one saturated colour: progress fill, rank number, avatar ring. */
  accent: string;
  /** A wash of `accent` used behind the monogram fallback avatar. */
  accentSoft: string;
}

/**
 * Colours are literal hex rather than tokens because satori has no cascade and
 * no CSS variables — every value is resolved at build-the-node-tree time, so an
 * indirection here would buy nothing but a lookup.
 */
export const PRESET_PALETTES: Record<CardPreset, PresetPalette> = {
  /** Discord's own dark surface, so a card does not glare in a dark-theme client. */
  midnight: {
    background: '#1a1c22',
    surface: '#2b2e36',
    text: '#f2f3f5',
    muted: '#a7adb8',
    accent: '#5865f2',
    accentSoft: '#343a63',
  },

  aurora: {
    background: '#0e2b2f',
    surface: '#164046',
    text: '#eafbf8',
    muted: '#8fc3bd',
    accent: '#22d3b8',
    accentSoft: '#175e57',
  },

  /**
   * The only light preset. It exists because a guild whose branding is light gets
   * a card that looks deliberate rather than one that looks like the dark one
   * failed to load.
   */
  parchment: {
    background: '#f6f1e7',
    surface: '#e3dbcb',
    text: '#2b2419',
    muted: '#6f6353',
    accent: '#b4621a',
    accentSoft: '#e8d3bb',
  },
};

export function paletteFor(preset: CardPreset): PresetPalette {
  return PRESET_PALETTES[preset];
}
