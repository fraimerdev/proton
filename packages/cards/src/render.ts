import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { type AvatarFetcher, nullAvatarFetcher, toDataUri } from './avatar.ts';
import {
  type CardDescriptor,
  type CardDescriptorInput,
  cardDescriptorSchema,
  sizeFor,
} from './descriptor.ts';
import { loadFonts } from './fonts.ts';
import { buildLayout } from './layout.ts';

/**
 * SVG → PNG, as a port.
 *
 * docs/PHASE-3.md R1 names `@resvg/resvg-js` (native NAPI) as the risk and
 * `@resvg/resvg-wasm` as the fallback. The spike settled it — resvg-js loads and
 * renders correctly under Bun 1.3 on Windows — so `ResvgRasteriser` below is the
 * real implementation and nothing is stubbed. The seam stays because swapping to
 * the wasm build on a platform where the native binary is unavailable should
 * touch one line, not the layout code.
 */
export interface SvgRasteriser {
  rasterise(svg: string, width: number): Uint8Array;
}

export const resvgRasteriser: SvgRasteriser = {
  rasterise(svg, width) {
    // Pinned to the descriptor's width rather than left to the SVG's own units,
    // so the PNG's IHDR dimensions are a function of the card kind alone. That is
    // what Gate 3 criterion 6 asserts.
    const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
    return rendered.asPng();
  },
};

export interface CardDeps {
  /**
   * Where avatar bitmaps come from. Defaults to fetching nothing.
   *
   * Off by default because the safe failure is a monogram, and a renderer that
   * silently reached the network the moment it was constructed would make every
   * test that forgot to inject one quietly network-dependent (I11). The worker
   * opts in with `new HttpAvatarFetcher()`.
   */
  avatars?: AvatarFetcher;
  rasteriser?: SvgRasteriser;
  /** Receives the reason an avatar was skipped. Rendering continues regardless. */
  onAvatarSkipped?: (reason: string) => void;
}

/**
 * Resolve the avatar to an embeddable data URI, or to `null`.
 *
 * Every failure path lands on `null` and the layout draws a monogram
 * (docs/PHASE-3.md G8: a CDN blip degrades the card, never fails the command).
 * The `catch` is not redundant with `HttpAvatarFetcher`'s own — an injected
 * fetcher is someone else's code, and this is the boundary where a card stops
 * being allowed to fail for a decorative reason.
 */
async function resolveAvatar(card: CardDescriptor, deps: CardDeps): Promise<string | null> {
  if (!card.avatarUrl) return null;

  const fetcher = deps.avatars ?? nullAvatarFetcher;
  let bytes: Uint8Array | null;
  try {
    bytes = await fetcher.fetch(card.avatarUrl);
  } catch (cause) {
    deps.onAvatarSkipped?.(
      `avatar fetcher threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }

  if (!bytes) return null;

  const uri = toDataUri(bytes);
  if (!uri) {
    deps.onAvatarSkipped?.('avatar bytes were not a PNG, JPEG or GIF, so they were not embedded');
  }
  return uri;
}

/** The SVG half, exported so a preset thumbnail can skip rasterising. */
export async function renderCardSvg(
  input: CardDescriptorInput,
  deps: CardDeps = {},
): Promise<string> {
  // Parsed, not trusted: the schema is the single source of truth for what a card
  // is, and this is the only door into the renderer.
  const card = cardDescriptorSchema.parse(input);
  const { width, height } = sizeFor(card.kind);
  const dataUri = await resolveAvatar(card, deps);

  // satori types its element as React's `ReactNode`, but it never touches React —
  // it reads `type`, `props.style` and `props.children` off plain objects, which
  // is exactly what `CardNode` is. The cast buys the correct shape at the one
  // call site instead of `@types/react` in a package that renders PNGs.
  const element = buildLayout(card, dataUri) as unknown as Parameters<typeof satori>[0];

  return satori(element, {
    width,
    height,
    fonts: await loadFonts(),
    // No `loadAdditionalAsset`: that hook is how satori reaches the network for
    // fonts and images mid-render, and G8 forbids network at render time. Its
    // absence is the enforcement.
  });
}

/**
 * Render a card to PNG bytes (PLAN.md §8, docs/PHASE-3.md §3.C).
 *
 * Deterministic by construction: the fonts are embedded, the palette is one of
 * three fixed tables, the layout is pure, and the only input that could vary
 * between runs — the avatar — is injected. Two calls with the same descriptor and
 * the same avatar bytes produce byte-identical PNGs, which is what lets CI assert
 * a card without a network (Gate 3 criterion 6).
 */
export async function renderCard(
  input: CardDescriptorInput,
  deps: CardDeps = {},
): Promise<Uint8Array> {
  const card = cardDescriptorSchema.parse(input);
  const svg = await renderCardSvg(card, deps);
  return (deps.rasteriser ?? resvgRasteriser).rasterise(svg, sizeFor(card.kind).width);
}
