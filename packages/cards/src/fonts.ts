import { readFile } from 'node:fs/promises';

export const FONT_FAMILY = 'Inter';

export const FONT_LICENCE = 'SIL Open Font License 1.1';

const FONT_FILES = [
  { weight: 400 as const, file: 'Inter-latin-400.ttf' },
  { weight: 700 as const, file: 'Inter-latin-700.ttf' },
];

export interface LoadedFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: 'normal';
}

let cache: Promise<LoadedFont[]> | null = null;

async function read(): Promise<LoadedFont[]> {
  return Promise.all(
    FONT_FILES.map(async ({ weight, file }) => {
      const url = new URL(`../assets/${file}`, import.meta.url);
      const bytes = await readFile(url);
      return {
        name: FONT_FAMILY,

        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        weight,
        style: 'normal' as const,
      };
    }),
  );
}

export async function loadFonts(): Promise<LoadedFont[]> {
  if (!cache) {
    cache = read().catch((cause: unknown) => {
      cache = null;
      throw new Error(
        `@proton/cards could not read its embedded ${FONT_FAMILY} fonts from packages/cards/assets. ` +
          'Cards cannot render without them and there is no network fallback by design. ' +
          `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    });
  }
  return cache;
}
