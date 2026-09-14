import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const SOURCE = join(import.meta.dir, '..', '..', '..', 'assets', 'brand', 'proton-mark.png');

// 128px covers the largest mark (34px on /signin) at 3x without shipping the 1024px source.
export const GENERATED_PATH = join(import.meta.dir, '..', 'public', 'brand', 'proton-mark-128.png');

const SIZE = 128;

export async function generate(): Promise<Buffer> {
  const image = await loadImage(SOURCE);
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, SIZE, SIZE);

  return canvas.encode('png');
}

if (import.meta.main) {
  const png = await generate();

  mkdirSync(dirname(GENERATED_PATH), { recursive: true });
  writeFileSync(GENERATED_PATH, png);

  console.log(`wrote ${png.byteLength} bytes to ${GENERATED_PATH}`);
}
