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

export interface SvgRasteriser {
  rasterise(svg: string, width: number): Uint8Array;
}

export const resvgRasteriser: SvgRasteriser = {
  rasterise(svg, width) {
    const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
    return rendered.asPng();
  },
};

export interface CardDeps {
  avatars?: AvatarFetcher;
  rasteriser?: SvgRasteriser;

  onAvatarSkipped?: (reason: string) => void;
}

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

export async function renderCardSvg(
  input: CardDescriptorInput,
  deps: CardDeps = {},
): Promise<string> {
  const card = cardDescriptorSchema.parse(input);
  const { width, height } = sizeFor(card.kind);
  const dataUri = await resolveAvatar(card, deps);

  const element = buildLayout(card, dataUri) as unknown as Parameters<typeof satori>[0];

  return satori(element, {
    width,
    height,
    fonts: await loadFonts(),
  });
}

export async function renderCard(
  input: CardDescriptorInput,
  deps: CardDeps = {},
): Promise<Uint8Array> {
  const card = cardDescriptorSchema.parse(input);
  const svg = await renderCardSvg(card, deps);
  return (deps.rasteriser ?? resvgRasteriser).rasterise(svg, sizeFor(card.kind).width);
}
