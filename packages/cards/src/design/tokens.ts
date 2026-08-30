export const FONT_FAMILY = 'Manrope';

export const FALLBACK_FONT_FAMILY = 'Inter';

// Manrope carries the design; Inter is behind it for the latin-1 glyphs Manrope's latin subset
// leaves out, which would otherwise draw as tofu boxes. The generic is for the browser half only —
// satori embeds both faces, but the live preview fetches them, and a blocked Google Fonts request
// would otherwise draw the whole card in the browser's default serif.
export const FONT_STACK = `${FONT_FAMILY}, ${FALLBACK_FONT_FAMILY}, sans-serif`;

export const FONT_WEIGHTS = [400, 600, 700, 800] as const;

export type FontWeight = (typeof FONT_WEIGHTS)[number];

export const CARD_WIDTH = 1100;
export const CARD_HEIGHT = 370;
export const CORNER_RADIUS = 50;

export const AVATAR_X = 67;
export const AVATAR_Y = 83;
export const AVATAR_SIZE = 216;
export const AVATAR_RING = 7;

export const CONTENT_LEFT = 320;
export const CONTENT_RIGHT = 1010;
export const COLUMN_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

export const BAR_LEFT = 310;
export const BAR_WIDTH = 700;
export const BAR_TOP = 255;
export const BAR_HEIGHT = 50;

export const ROW_GAP = 12;

// Every text box in the card sets this. Left at 'normal', satori takes the line box from the font's
// own ascent/descent and a browser adds its own leading, and the two disagree by a pixel per box —
// which is how the same component drifts between the PNG Discord gets and the dashboard preview.
export const LINE_HEIGHT = 1.3;

// satori and the browser also disagree on alignItems:'baseline' — satori made the name row 89px
// tall where Chrome made it 66. So mixed sizes bottom-align and the smaller one is lifted by hand.
// With a fixed line height a baseline sits this far above its box bottom, in ems.
const BASELINE_ABOVE_BOTTOM = 0.31;

export function baselineLift(larger: number, smaller: number): number {
  return Math.round((larger - smaller) * BASELINE_ABOVE_BOTTOM);
}

// The original card placed its text on baselines. A line box of LINE_HEIGHT puts the baseline one
// em below the box top, so a row that wants its baseline at b starts at b minus its largest size.
export function rowTop(baseline: number, largest: number): number {
  return baseline - largest;
}

export function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function hex(rgb: number[]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return hex(a.map((channel, index) => channel + ((b[index] ?? 0) - channel) * amount));
}
