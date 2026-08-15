export const CARD_PRESETS = ['midnight', 'aurora', 'parchment'] as const;

export type CardPreset = (typeof CARD_PRESETS)[number];

export interface PresetPalette {
  background: string;

  surface: string;

  text: string;

  muted: string;

  accent: string;

  accentSoft: string;
}

export const PRESET_PALETTES: Record<CardPreset, PresetPalette> = {
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
