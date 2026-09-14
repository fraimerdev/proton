import { NAME_STYLE_FONTS, type NameStyleFont } from '@proton/module-branding/name-style';
import { useEffect, useMemo, useState } from 'react';
import { FACE_RANGES, faceFor } from './faces.ts';
import { graphemes, isEmoji } from './shape.ts';

const registered = new Map<NameStyleFont, Promise<readonly FontFace[]>>();

function register(slug: NameStyleFont): Promise<readonly FontFace[]> {
  const known = registered.get(slug);
  if (known !== undefined) return known;

  const face = faceFor(slug);
  const pending = import('./font-files.ts').then(({ FACE_FILES }) =>
    FACE_FILES[slug].map((file) => {
      const added = new FontFace(face.family, `url(${file.url}) format('woff2')`, {
        weight: String(face.weight),
        style: 'normal',
        display: 'swap',
        unicodeRange: FACE_RANGES[file.subset],
      });
      document.fonts.add(added);
      return added;
    }),
  );

  registered.set(slug, pending);
  return pending;
}

export async function loadFace(slug: NameStyleFont, text: string): Promise<void> {
  const face = faceFor(slug);
  const pending = register(slug);

  try {
    const added = await pending;
    await document.fonts.load(`${face.weight} 32px "${face.family}"`, text === '' ? ' ' : text);
    if (added.some((candidate) => candidate.status === 'error')) {
      throw new Error(`Proton could not load the ${face.drawnIn} file.`);
    }
  } catch (error) {
    // A FontFace that failed stays failed, so a retry has to start from fresh ones.
    registered.delete(slug);
    for (const added of await pending.catch(() => [])) document.fonts.delete(added);
    throw error;
  }
}

export interface FaceLoad {
  status: 'loading' | 'ready' | 'failed';
  failed: readonly NameStyleFont[];
}

const LOADING: FaceLoad = { status: 'loading', failed: [] };

export function useFaces(slugs: readonly NameStyleFont[], text: string): FaceLoad {
  const wanted = slugs.join(' ');
  const key = `${wanted}|${text}`;
  const [result, setResult] = useState<{ key: string; load: FaceLoad }>({
    key: '',
    load: LOADING,
  });

  useEffect(() => {
    let current = true;
    const list = NAME_STYLE_FONTS.filter((font) => wanted.split(' ').includes(font));

    void Promise.allSettled(list.map((slug) => loadFace(slug, text))).then((settled) => {
      if (!current) return;

      const failed = list.filter((_, index) => settled[index]?.status === 'rejected');
      setResult({
        key: `${wanted}|${text}`,
        load: { status: failed.length === 0 ? 'ready' : 'failed', failed },
      });
    });

    return () => {
      current = false;
    };
  }, [wanted, text]);

  return result.key === key ? result.load : LOADING;
}

const measured = new Map<string, boolean>();
let context: CanvasRenderingContext2D | null | undefined;

function widthOf(
  canvas: CanvasRenderingContext2D,
  weight: number,
  stack: string,
  grapheme: string,
): number {
  canvas.font = `${weight} 48px ${stack}`;
  return canvas.measureText(grapheme).width;
}

function lacks(slug: NameStyleFont, grapheme: string): boolean {
  const key = `${slug}|${grapheme}`;
  const known = measured.get(key);
  if (known !== undefined) return known;

  context ??= document.createElement('canvas').getContext('2d');
  if (context === null) return false;

  const face = faceFor(slug);
  const own = `"${face.family}"`;
  const missing =
    widthOf(context, face.weight, `${own}, monospace`, grapheme) ===
      widthOf(context, face.weight, 'monospace', grapheme) &&
    widthOf(context, face.weight, `${own}, serif`, grapheme) ===
      widthOf(context, face.weight, 'serif', grapheme);

  measured.set(key, missing);
  return missing;
}

const NONE: ReadonlySet<number> = new Set();

export function useMissingGlyphs(
  slug: NameStyleFont,
  text: string,
  ready: boolean,
): ReadonlySet<number> {
  return useMemo(() => {
    if (!ready) return NONE;

    const missing = new Set<number>();
    for (const [index, grapheme] of graphemes(text).entries()) {
      if (grapheme.trim() === '' || isEmoji(grapheme)) continue;
      if (lacks(slug, grapheme)) missing.add(index);
    }

    return missing;
  }, [slug, text, ready]);
}
