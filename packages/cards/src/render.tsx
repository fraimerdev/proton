import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { type ImageFetcher, imageMimeType, nullImageFetcher } from './avatar.ts';
import {
  type CardDescriptor,
  type CardDescriptorInput,
  cardDescriptorSchema,
  sizeFor,
} from './descriptor.ts';
import { Card, type CardImages } from './design/card.tsx';
import { satoriFonts } from './fonts.ts';

export interface CardDeps {
  images?: ImageFetcher;

  onImageSkipped?: (reason: string) => void;
}

// satori would happily fetch an http src itself, which would put an unvetted request on the wire
// from inside the renderer. Everything reaches the tree as a data: URI that HttpImageFetcher has
// already allow-listed, size-capped and sniffed.
async function resolve(
  url: string | undefined,
  what: string,
  deps: CardDeps,
): Promise<string | undefined> {
  if (!url) return undefined;

  const fetcher = deps.images ?? nullImageFetcher;
  let bytes: Uint8Array | null;
  try {
    bytes = await fetcher.fetch(url);
  } catch (cause) {
    deps.onImageSkipped?.(
      `${what} fetcher threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }

  if (!bytes) return undefined;

  const mime = imageMimeType(bytes);
  if (!mime) {
    deps.onImageSkipped?.(`${what} bytes were not a PNG, JPEG or GIF, so they were not drawn`);
    return undefined;
  }

  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

export async function renderSvg(input: CardDescriptorInput, deps: CardDeps = {}): Promise<string> {
  const card: CardDescriptor = cardDescriptorSchema.parse(input);
  const size = sizeFor(card.kind);

  const [avatarSrc, backgroundSrc] = await Promise.all([
    resolve(card.avatarUrl, 'the avatar', deps),
    resolve(card.backgroundUrl, 'the background', deps),
  ]);

  const images: CardImages = {
    ...(avatarSrc === undefined ? {} : { avatarSrc }),
    ...(backgroundSrc === undefined ? {} : { backgroundSrc }),
  };

  return satori(<Card card={card} images={images} />, {
    width: size.width,
    height: size.height,
    fonts: satoriFonts(),
  });
}

export async function renderCard(
  input: CardDescriptorInput,
  deps: CardDeps = {},
): Promise<Uint8Array> {
  return new Resvg(await renderSvg(input, deps)).render().asPng();
}
