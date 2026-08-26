import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_STACK, monogram, paletteFor, registerFonts } from '@proton/cards';

// The member whose message the starboard scene reposts. Drawn the same way the rank card draws a
// member with no Discord avatar — same preset, same monogram, same face — so the two scenes on
// the landing page are recognisably one person.
export const GENERATED_PATH = join(import.meta.dir, '..', 'public', 'art', 'author-avatar.png');

const DISPLAY_NAME = 'Rin';
const SIZE = 128;

export function generate(): Uint8Array {
  registerFonts();

  const palette = paletteFor('midnight');
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const centre = SIZE / 2;

  ctx.beginPath();
  ctx.arc(centre, centre, centre, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = palette.accentSoft;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = palette.text;
  ctx.font = `bold ${Math.round(SIZE * 0.42)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(monogram(DISPLAY_NAME), centre, centre);

  return canvas.toBuffer('image/png');
}

if (import.meta.main) {
  const png = generate();
  writeFileSync(GENERATED_PATH, png);

  console.log(`wrote ${png.byteLength} bytes to ${GENERATED_PATH}`);
}
