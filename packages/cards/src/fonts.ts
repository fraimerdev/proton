import { readFile } from 'node:fs/promises';

/**
 * The embedded typeface (docs/PHASE-3.md G8: "Fonts must be embedded. No network
 * at render time.").
 *
 * Inter, latin subset, SIL Open Font License 1.1 — see `LICENSES.md`, which
 * carries the full text and is what satisfies OFL §2's requirement that the
 * licence travel with the font. OFL permits redistribution inside a commercial
 * product, which is the constraint docs/PHASE-3.md §6 Q3 asked about.
 *
 * **Two static weights, not one variable font — and that is forced, not chosen.**
 * satori 0.29 bundles `@shuding/opentype.js@1.4.0-beta.0`, a fork that deleted
 * the `name` table parser but kept `fvar`'s dependency on it, so
 * `parseFvarAxis` dereferences an always-`undefined` `names` map and throws
 * `undefined is not an object` for **every** font carrying an `fvar` table.
 * Reproduced here with Inter Variable and Noto Sans Variable; not a Bun problem
 * and not a Windows problem. If a future satori restores name-table parsing,
 * collapsing these two files into one variable face is a drop-in change: only
 * `FONT_FILES` and `loadFonts` know there are two.
 *
 * Latin subset because the alternative is a 300 KB+ full-charset file per weight
 * in git for glyphs no card layout has room for. The cost is real and is handled
 * rather than ignored — see `sanitiseText` in `layout.ts`.
 */
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

/**
 * Read once per process, not once per card.
 *
 * A promise rather than a resolved value so concurrent first renders share the
 * single read instead of racing two of them; a rejected read is not cached, so a
 * transient failure does not poison every later render.
 */
let cache: Promise<LoadedFont[]> | null = null;

async function read(): Promise<LoadedFont[]> {
  return Promise.all(
    FONT_FILES.map(async ({ weight, file }) => {
      const url = new URL(`../assets/${file}`, import.meta.url);
      const bytes = await readFile(url);
      return {
        name: FONT_FAMILY,
        // A fresh, exactly-sized copy: `Buffer` views a pooled allocation, so
        // handing satori `bytes.buffer` would hand it the whole pool and every
        // glyph offset would be wrong.
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
