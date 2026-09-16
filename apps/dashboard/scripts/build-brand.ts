import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const BRAND = join(import.meta.dir, '..', '..', '..', 'assets', 'brand');

const PUBLIC = join(import.meta.dir, '..', 'public', 'brand');

// 128px covers the largest mark (34px on /signin) at 3x without shipping the 1024px source.
export const GENERATED_PATH = join(PUBLIC, 'proton-mark-128.png');

export const AVATAR_PATH = join(PUBLIC, 'proton-avatar-120.png');

async function resized(file: string, size: number): Promise<Buffer> {
  const image = await loadImage(join(BRAND, file));
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, size, size);

  return canvas.encode('png');
}

export function generate(): Promise<Buffer> {
  return resized('proton-mark.png', 128);
}

export function generateAvatar(): Promise<Buffer> {
  return resized('proton-icon.png', 120);
}

if (import.meta.main) {
  const outputs: [string, Buffer][] = [
    [GENERATED_PATH, await generate()],
    [AVATAR_PATH, await generateAvatar()],
  ];

  for (const [path, png] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png);

    console.log(`wrote ${png.byteLength} bytes to ${path}`);
  }
}
