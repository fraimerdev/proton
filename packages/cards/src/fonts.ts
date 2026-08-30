import { readFileSync } from 'node:fs';
import { GlobalFonts } from '@napi-rs/canvas';
import {
  FALLBACK_FONT_FAMILY,
  FONT_FAMILY,
  FONT_WEIGHTS,
  type FontWeight,
} from './design/tokens.ts';

interface FontFile {
  family: string;
  weight: FontWeight;
  file: string;
}

const FONT_FILES: FontFile[] = [
  ...FONT_WEIGHTS.map((weight) => ({
    family: FONT_FAMILY,
    weight,
    file: `Manrope-latin-${weight}.woff`,
  })),
  { family: FALLBACK_FONT_FAMILY, weight: 400, file: 'Inter-latin-400.ttf' },
  { family: FALLBACK_FONT_FAMILY, weight: 700, file: 'Inter-latin-700.ttf' },
];

function read(file: string): Buffer {
  try {
    return readFileSync(new URL(`../assets/${file}`, import.meta.url));
  } catch (cause) {
    throw new Error(
      `@proton/cards could not read ${file} from packages/cards/assets. Cards cannot render ` +
        'without their embedded fonts and there is no network fallback by design. ' +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export interface SatoriFont {
  name: string;
  data: Buffer;
  weight: FontWeight;
  style: 'normal';
}

let satoriCache: SatoriFont[] | null = null;

export function satoriFonts(): SatoriFont[] {
  satoriCache ??= FONT_FILES.map(({ family, weight, file }) => ({
    name: family,
    data: read(file),
    weight,
    style: 'normal' as const,
  }));

  return satoriCache;
}

let registered = false;

// The captcha still draws through @napi-rs/canvas, which wants its faces in a global registry
// rather than passed per render. Cards go through satori and take satoriFonts() instead.
export function registerFonts(): void {
  if (registered) return;

  for (const { family, file } of FONT_FILES) {
    if (!GlobalFonts.register(read(file), family)) {
      throw new Error(
        `@proton/cards could not register ${file} as '${family}': @napi-rs/canvas rejected the ` +
          'font binary. Replace it from the @fontsource package it came from.',
      );
    }
  }

  registered = true;
}
