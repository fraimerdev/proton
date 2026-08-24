import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { z } from 'zod';
import { FALLBACK_FONT_FAMILY, FONT_FAMILY, registerFonts } from './fonts.ts';

export const CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789';

const CAPTCHA_MAX_LENGTH = 12;

export const captchaInputSchema = z.object({
  text: z.string().min(1).max(CAPTCHA_MAX_LENGTH),
  width: z.number().int().min(160).max(960).default(380),
  height: z.number().int().min(80).max(360).default(140),
});

export type CaptchaInput = z.input<typeof captchaInputSchema>;

export interface CaptchaDeps {
  random?: () => number;
}

// 256 is not a multiple of 27, so drawing past the last whole cycle is what keeps answers uniform.
const ANSWER_BYTE_CEILING = 256 - (256 % CAPTCHA_ALPHABET.length);

export function newCaptchaAnswer(length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > CAPTCHA_MAX_LENGTH) {
    throw new Error(
      `@proton/cards cannot mint a captcha answer of ${length} characters. verification's ` +
        `captchaLength is the setting that chose it, and it must be a whole number from 1 to ` +
        `${CAPTCHA_MAX_LENGTH} — the ceiling captchaInputSchema.text puts on what renderCaptcha ` +
        'will draw. The verification module pins the setting to 4..8.',
    );
  }

  let answer = '';
  const buffer = new Uint8Array(length);

  while (answer.length < length) {
    crypto.getRandomValues(buffer);

    for (const byte of buffer) {
      if (byte >= ANSWER_BYTE_CEILING) continue;

      answer += CAPTCHA_ALPHABET[byte % CAPTCHA_ALPHABET.length];
      if (answer.length === length) break;
    }
  }

  return answer;
}

const BACKDROP_FROM = '#f7f9fd';
const BACKDROP_TO = '#dbe1f0';

const SPECKLE = ['#c3ccdf', '#d6dbe9', '#b6c0d6'] as const;
const SPECKLE_AREA_PER_DOT = 220;

const INK = ['#1b2f5e', '#3f1f5e', '#0f4f36', '#5e1f2d', '#4a4416'] as const;

const GLYPH_ROTATION = { min: 0.11, max: 0.26 };
const GLYPH_SKEW = { min: 0.1, max: 0.22 };
const GLYPH_JITTER = { min: 0.065, max: 0.11 };
const GLYPH_ADVANCE = { min: 0.1, max: 0.22 };
const GLYPH_MARGIN = 0.06;

const GLYPH_SCALE_MIN = 0.78;
const GLYPH_SCALE_RANGE = 0.44;
const GLYPH_REACH = 0.42;

const BASELINE_TILT = { min: 0.085, max: 0.15 };

const WARP_AMPLITUDE = 6;
const WARP_AMPLITUDE_RANGE = 3;
const WARP_PERIOD = 14;
const WARP_PERIOD_RANGE = 9;
const WARP_REACH = WARP_AMPLITUDE + WARP_AMPLITUDE_RANGE;

const STROKE_WIDTH = 1.1;
const STROKE_WIDTH_RANGE = 1.1;

function inkColour(random: () => number): string {
  return INK[Math.floor(random() * INK.length)] ?? INK[0];
}

function swing(random: () => number, span: { min: number; max: number }): number {
  const magnitude = span.min + random() * (span.max - span.min);
  return random() < 0.5 ? -magnitude : magnitude;
}

function paintBackdrop(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  random: () => number,
): void {
  const wash = ctx.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, BACKDROP_FROM);
  wash.addColorStop(1, BACKDROP_TO);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  const dots = Math.round((width * height) / SPECKLE_AREA_PER_DOT);
  for (let dot = 0; dot < dots; dot += 1) {
    ctx.beginPath();
    ctx.arc(random() * width, random() * height, 0.5 + random() * 1.6, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = SPECKLE[Math.floor(random() * SPECKLE.length)] ?? SPECKLE[0];
    ctx.fill();
  }
}

function drawGlyphs(
  ctx: SKRSContext2D,
  text: string,
  width: number,
  height: number,
  random: () => number,
): void {
  const glyphs = [...text];
  const run = width * (1 - GLYPH_MARGIN * 2);
  const slot = run / glyphs.length;
  const size = Math.min(height * 0.66, slot * 1.35);

  // Walked, not indexed off a fixed grid: even centres score a guess as well as the real answer.
  const drawn = glyphs.map(() => slot * (1 + swing(random, GLYPH_ADVANCE)));
  const walked = drawn.reduce((total, advance) => total + advance, 0);
  const centres: number[] = [];

  let cursor = width * GLYPH_MARGIN;
  for (const advance of drawn) {
    const fitted = (advance * run) / walked;
    centres.push(cursor + fitted / 2);
    cursor += fitted;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const tilt = swing(random, BASELINE_TILT);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(tilt);
  ctx.translate(-width / 2, -height / 2);

  for (const [index, glyph] of glyphs.entries()) {
    const family = random() < 0.5 ? FONT_FAMILY : FALLBACK_FONT_FAMILY;
    const face = Math.round(size * (GLYPH_SCALE_MIN + random() * GLYPH_SCALE_RANGE));
    const centre = centres[index] ?? width / 2;

    const tilted = Math.abs((centre - width / 2) * Math.sin(tilt));
    const room = Math.max(0, height / 2 - face * GLYPH_REACH - tilted - WARP_REACH);
    const drop = Math.max(-room, Math.min(room, swing(random, GLYPH_JITTER) * height));

    ctx.save();
    ctx.font = `bold ${face}px ${family}`;
    ctx.translate(centre, height / 2 + drop);
    ctx.rotate(swing(random, GLYPH_ROTATION));
    ctx.transform(1, 0, swing(random, GLYPH_SKEW), 1, 0, 0);
    ctx.fillStyle = inkColour(random);
    ctx.fillText(glyph, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

function warp(ctx: SKRSContext2D, width: number, height: number, random: () => number): void {
  const source = ctx.getImageData(0, 0, width, height).data;
  const target = ctx.createImageData(width, height);
  const painted = target.data;

  const rowAmplitude = WARP_AMPLITUDE + random() * WARP_AMPLITUDE_RANGE;
  const rowPeriod = WARP_PERIOD + random() * WARP_PERIOD_RANGE;
  const rowPhase = random() * Math.PI * 2;
  const columnAmplitude = WARP_AMPLITUDE + random() * WARP_AMPLITUDE_RANGE;
  const columnPeriod = WARP_PERIOD + random() * WARP_PERIOD_RANGE;
  const columnPhase = random() * Math.PI * 2;

  for (let y = 0; y < height; y += 1) {
    const shiftX = Math.round(rowAmplitude * Math.sin(y / rowPeriod + rowPhase));

    for (let x = 0; x < width; x += 1) {
      const shiftY = Math.round(columnAmplitude * Math.sin(x / columnPeriod + columnPhase));

      // Sampled FROM, not displaced TO: displacing the destination leaves unwritten seams.
      const sourceY = Math.min(height - 1, Math.max(0, y + shiftY));
      const sourceX = Math.min(width - 1, Math.max(0, x + shiftX));

      const from = (sourceY * width + sourceX) * 4;
      const to = (y * width + x) * 4;

      painted[to] = source[from] ?? 0;
      painted[to + 1] = source[from + 1] ?? 0;
      painted[to + 2] = source[from + 2] ?? 0;
      painted[to + 3] = source[from + 3] ?? 255;
    }
  }

  ctx.putImageData(target, 0, 0);
}

function drawNoiseStrokes(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  random: () => number,
  strokes: number,
): void {
  ctx.lineCap = 'round';

  for (let stroke = 0; stroke < strokes; stroke += 1) {
    ctx.beginPath();
    ctx.moveTo(-2, random() * height);
    ctx.bezierCurveTo(
      width * 0.3,
      random() * height,
      width * 0.7,
      random() * height,
      width + 2,
      random() * height,
    );
    ctx.lineWidth = STROKE_WIDTH + random() * STROKE_WIDTH_RANGE;
    ctx.strokeStyle = inkColour(random);
    ctx.stroke();
  }
}

export async function renderCaptcha(
  input: CaptchaInput,
  deps: CaptchaDeps = {},
): Promise<Uint8Array> {
  const { text, width, height } = captchaInputSchema.parse(input);
  const random = deps.random ?? Math.random;

  registerFonts();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  paintBackdrop(ctx, width, height, random);

  // Strokes go under the glyphs and warp with them: on top they stay clean beziers to subtract.
  drawNoiseStrokes(ctx, width, height, random, 2 + Math.floor(random() * 2));
  drawGlyphs(ctx, text, width, height, random);
  drawNoiseStrokes(ctx, width, height, random, 1);
  warp(ctx, width, height, random);

  return canvas.toBuffer('image/png');
}
