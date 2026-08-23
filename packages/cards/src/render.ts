import { createCanvas, type Image, loadImage } from '@napi-rs/canvas';
import { type ImageFetcher, isRenderableImage, nullImageFetcher } from './avatar.ts';
import {
  type CardDescriptor,
  type CardDescriptorInput,
  cardDescriptorSchema,
  sizeFor,
} from './descriptor.ts';
import { drawCard } from './draw.ts';
import { registerFonts } from './fonts.ts';

export interface CardDeps {
  images?: ImageFetcher;

  onImageSkipped?: (reason: string) => void;
}

async function resolve(
  url: string | undefined,
  what: string,
  deps: CardDeps,
): Promise<Image | null> {
  if (!url) return null;

  const fetcher = deps.images ?? nullImageFetcher;
  let bytes: Uint8Array | null;
  try {
    bytes = await fetcher.fetch(url);
  } catch (cause) {
    deps.onImageSkipped?.(
      `${what} fetcher threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }

  if (!bytes) return null;

  if (!isRenderableImage(bytes)) {
    deps.onImageSkipped?.(`${what} bytes were not a PNG, JPEG or GIF, so they were not drawn`);
    return null;
  }

  try {
    return await loadImage(bytes);
  } catch (cause) {
    deps.onImageSkipped?.(
      `${what} could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }
}

export async function renderCard(
  input: CardDescriptorInput,
  deps: CardDeps = {},
): Promise<Uint8Array> {
  const card: CardDescriptor = cardDescriptorSchema.parse(input);
  const size = sizeFor(card.kind);

  registerFonts();

  const [avatar, background] = await Promise.all([
    resolve(card.avatarUrl, 'the avatar', deps),
    resolve(card.backgroundUrl, 'the background', deps),
  ]);

  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');

  drawCard(ctx, card, { avatar, background }, size);

  return canvas.toBuffer('image/png');
}
