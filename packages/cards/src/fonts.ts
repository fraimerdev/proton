import { readFileSync } from 'node:fs';
import { GlobalFonts } from '@napi-rs/canvas';

export const FONT_FAMILY = 'Manrope';

export const FALLBACK_FONT_FAMILY = 'Inter';

// Manrope carries the design; Inter is behind it for the latin-1 glyphs Manrope's latin subset
// leaves out, which would otherwise draw as tofu boxes.
export const FONT_STACK = `${FONT_FAMILY}, ${FALLBACK_FONT_FAMILY}`;

export const FONT_LICENCE = 'SIL Open Font License 1.1';

const FONT_FILES = [
  { family: FONT_FAMILY, file: 'Manrope-latin-400.woff2' },
  { family: FONT_FAMILY, file: 'Manrope-latin-700.woff2' },
  { family: FALLBACK_FONT_FAMILY, file: 'Inter-latin-400.ttf' },
  { family: FALLBACK_FONT_FAMILY, file: 'Inter-latin-700.ttf' },
];

let registered = false;

export function registerFonts(): void {
  if (registered) return;

  for (const { family, file } of FONT_FILES) {
    const url = new URL(`../assets/${file}`, import.meta.url);
    let bytes: Buffer;
    try {
      bytes = readFileSync(url);
    } catch (cause) {
      throw new Error(
        `@proton/cards could not read ${file} from packages/cards/assets. Cards cannot render ` +
          'without their embedded fonts and there is no network fallback by design. ' +
          `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    if (!GlobalFonts.register(bytes, family)) {
      throw new Error(
        `@proton/cards could not register ${file} as '${family}': @napi-rs/canvas rejected the ` +
          'font binary. Replace it from the @fontsource package it came from.',
      );
    }
  }

  registered = true;
}

export function registeredFamilies(): string[] {
  registerFonts();
  return [...new Set(FONT_FILES.map(({ family }) => family))];
}
