export const DEFAULT_CARD_ACCENT = 0x317ff5;

export const CARD_PRESETS = ['midnight', 'aurora', 'parchment'] as const;

export type CardPreset = (typeof CARD_PRESETS)[number];

export interface PresetPalette {
  background: string;

  surface: string;

  line: string;

  // Opaque, not a white wash: the track sits over a guild's background image as often as over the
  // card's own ground, and a photo showing through the one element that must be read precisely is
  // the difference between a progress bar and a smear.
  track: string;

  text: string;

  muted: string;

  accent: string;

  accentSoft: string;
}

export const PRESET_PALETTES: Record<CardPreset, PresetPalette> = {
  midnight: {
    background: '#0a0a0a',
    surface: '#17181b',
    line: 'rgba(255, 255, 255, 0.10)',
    track: '#4d4d4d',
    text: '#f4f6f9',
    muted: '#8b8f98',
    accent: '#317ff5',
    accentSoft: '#16233a',
  },

  aurora: {
    background: '#04110f',
    surface: '#0d2320',
    line: 'rgba(255, 255, 255, 0.10)',
    track: '#38504c',
    text: '#eafbf8',
    muted: '#7fada8',
    accent: '#15b39b',
    accentSoft: '#0f4b43',
  },

  parchment: {
    background: '#f7f3ec',
    surface: '#e9e1d3',
    line: 'rgba(28, 22, 14, 0.14)',
    track: '#cfc6b6',
    text: '#211b12',
    muted: '#6c6252',
    accent: '#b4621a',
    accentSoft: '#e5cdb0',
  },
};

export function paletteFor(preset: CardPreset): PresetPalette {
  return PRESET_PALETTES[preset];
}

export function toHexColour(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.trunc(value)))
    .toString(16)
    .padStart(6, '0')}`;
}
