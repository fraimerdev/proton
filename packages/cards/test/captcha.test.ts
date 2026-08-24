import { describe, expect, test } from 'bun:test';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import {
  CAPTCHA_ALPHABET,
  captchaInputSchema,
  FONT_FAMILY,
  newCaptchaAnswer,
  registerFonts,
  renderCaptcha,
} from '../src/index.ts';
import { PNG_MAGIC, readPng } from './png.ts';

function seeded(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TEXT = 'AKQ7WD';
const OTHER_TEXT = 'WD7QKA';
const DEFAULT_SIZE = { width: 380, height: 140 };

const ANSWER_CEILING = captchaInputSchema.shape.text.maxLength ?? 0;

describe('renderCaptcha', () => {
  test('renders a PNG at the default size', async () => {
    const header = readPng(await renderCaptcha({ text: TEXT }));

    expect(header.magic).toEqual(PNG_MAGIC);
    expect(header.ihdr).toBe('IHDR');
    expect({ width: header.width, height: header.height }).toEqual(DEFAULT_SIZE);
  });

  test('renders at the size it is asked for', async () => {
    const header = readPng(await renderCaptcha({ text: TEXT, width: 480, height: 200 }));

    expect(header.magic).toEqual(PNG_MAGIC);
    expect(header.ihdr).toBe('IHDR');
    expect({ width: header.width, height: header.height }).toEqual({ width: 480, height: 200 });
  });

  test('the same text and the same random render byte-identically', async () => {
    const [a, b] = await Promise.all([
      renderCaptcha({ text: TEXT }, { random: seeded(11) }),
      renderCaptcha({ text: TEXT }, { random: seeded(11) }),
    ]);

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('a different random renders a different picture', async () => {
    const [a, b] = await Promise.all([
      renderCaptcha({ text: TEXT }, { random: seeded(11) }),
      renderCaptcha({ text: TEXT }, { random: seeded(12) }),
    ]);

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('a different answer renders a different picture', async () => {
    const [a, b] = await Promise.all([
      renderCaptcha({ text: TEXT }, { random: seeded(11) }),
      renderCaptcha({ text: OTHER_TEXT }, { random: seeded(11) }),
    ]);

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('an unseeded render still differs from the one before it', async () => {
    const [a, b] = await Promise.all([
      renderCaptcha({ text: TEXT }),
      renderCaptcha({ text: TEXT }),
    ]);

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('input the schema refuses never reaches the canvas', async () => {
    await expect(renderCaptcha({ text: '' })).rejects.toThrow();
    await expect(renderCaptcha({ text: TEXT, width: 12 })).rejects.toThrow();
    await expect(renderCaptcha({ text: TEXT, height: 5_000 })).rejects.toThrow();
  });
});

type Frame = ReturnType<SKRSContext2D['getImageData']>;

const INK_LUMA = 128;
const CORE_INK_LUMA = 70;
const FAMILY_MARGIN = 12;
const FAMILY_FLOOR = 20;

function luma(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114;
}

function channels(frame: Frame, pixel: number): [number, number, number] {
  return [
    frame.data[pixel * 4] ?? 0,
    frame.data[pixel * 4 + 1] ?? 0,
    frame.data[pixel * 4 + 2] ?? 0,
  ];
}

async function decode(png: Uint8Array): Promise<Frame> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  return ctx.getImageData(0, 0, image.width, image.height);
}

function undistorted(text: string, width: number, height: number): Frame {
  registerFonts();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#101010';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 60px ${FONT_FAMILY}`;

  const glyphs = [...text];
  for (const [index, glyph] of glyphs.entries()) {
    ctx.fillText(glyph, (width / (glyphs.length + 1)) * (index + 1), height / 2);
  }

  return ctx.getImageData(0, 0, width, height);
}

function ink(frame: Frame): Uint8Array {
  const mask = new Uint8Array(frame.width * frame.height);

  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = luma(...channels(frame, pixel)) < INK_LUMA ? 1 : 0;
  }

  return mask;
}

function inkFraction(mask: Uint8Array): number {
  let inked = 0;
  for (const pixel of mask) if (pixel === 1) inked += 1;

  return inked / mask.length;
}

function blankColumns(mask: Uint8Array, width: number, height: number): number {
  let blank = 0;

  for (let x = 0; x < width; x += 1) {
    let inked = false;
    for (let y = 0; y < height && !inked; y += 1) inked = mask[y * width + x] === 1;
    if (!inked) blank += 1;
  }

  return blank;
}

function inkedRows(mask: Uint8Array, width: number, height: number): number {
  let rows = 0;

  for (let y = 0; y < height; y += 1) {
    let inked = false;
    for (let x = 0; x < width && !inked; x += 1) inked = mask[y * width + x] === 1;
    if (inked) rows += 1;
  }

  return rows / height;
}

function agreement(reference: Uint8Array, candidate: Uint8Array): number {
  let shared = 0;
  let total = 0;

  for (let pixel = 0; pixel < reference.length; pixel += 1) {
    if (reference[pixel] !== 1) continue;
    total += 1;
    if (candidate[pixel] === 1) shared += 1;
  }

  return shared / total;
}

function inkFamilies(frame: Frame): number {
  const tally = { red: 0, green: 0, blue: 0 };

  for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
    const [r, g, b] = channels(frame, pixel);
    if (luma(r, g, b) >= CORE_INK_LUMA) continue;

    if (r > g + FAMILY_MARGIN && r > b + FAMILY_MARGIN) tally.red += 1;
    if (g > r + FAMILY_MARGIN && g > b + FAMILY_MARGIN) tally.green += 1;
    if (b > r + FAMILY_MARGIN && b > g + FAMILY_MARGIN) tally.blue += 1;
  }

  return Object.values(tally).filter((count) => count > FAMILY_FLOOR).length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function share(values: number[], matches: (value: number) => boolean): number {
  return values.filter(matches).length / values.length;
}

interface Draw {
  agreement: number;
  margin: number;
  blankColumns: number;
  inkedRows: number;
  families: number;
}

const SAMPLE_SIZE = 60;

const CONTROL_INK_MIN = 0.02;
const CONTROL_INK_MAX = 0.25;
const AGREEMENT_MEDIAN_MAX = 0.46;
const AGREEMENT_TAIL_AT = 0.5;
const AGREEMENT_TAIL_SHARE_MAX = 0.1;
const AGREEMENT_WORST_MAX = 0.65;
const MARGIN_MEDIAN_MAX = 0.09;
const MARGIN_TAIL_AT = 0.15;
const MARGIN_TAIL_SHARE_MAX = 0.05;
const MARGIN_WORST_MAX = 0.25;
const BLANK_SHARE_MAX = 0.05;
const BLANK_COLUMNS_MAX = 3;
const FAMILY_SHARE_MAX = 0.05;
const SPREAD_OVER_STRAIGHT = 1.6;

const { width, height } = DEFAULT_SIZE;
const straight = undistorted(TEXT, width, height);
const straightInk = ink(straight);

async function drawSeed(seed: number): Promise<Draw> {
  const [same, other] = await Promise.all([
    renderCaptcha({ text: TEXT }, { random: seeded(seed) }),
    renderCaptcha({ text: OTHER_TEXT }, { random: seeded(seed) }),
  ]);

  const frame = await decode(same);
  const mask = ink(frame);

  // One seed for both, so only the glyphs differ: reseeding moves the noise and voids the control.
  const knowing = agreement(straightInk, mask);
  const guessing = agreement(straightInk, ink(await decode(other)));

  return {
    agreement: knowing,
    margin: knowing - guessing,
    blankColumns: blankColumns(mask, width, height),
    inkedRows: inkedRows(mask, width, height),
    families: inkFamilies(frame),
  };
}

const sample: Draw[] = [];
for (let seed = 1; seed <= SAMPLE_SIZE; seed += 1) sample.push(await drawSeed(seed));

describe('the captcha resists reading, not merely parsing', () => {
  test('the straight render really is readable, or nothing below proves anything', () => {
    expect(inkFraction(straightInk)).toBeGreaterThan(CONTROL_INK_MIN);
    expect(inkFraction(straightInk)).toBeLessThan(CONTROL_INK_MAX);
    expect(blankColumns(straightInk, width, height)).toBeGreaterThanOrEqual(TEXT.length - 1);
    expect(inkedRows(straightInk, width, height)).toBeLessThan(0.5);
    expect(inkFamilies(straight)).toBe(0);
  });

  test(`the typical one of ${SAMPLE_SIZE} seeds keeps a template match well off the answer`, () => {
    expect(median(sample.map((draw) => draw.agreement))).toBeLessThan(AGREEMENT_MEDIAN_MAX);
  });

  test('the seeds that land nearest the straight render are a thin tail, not the rule', () => {
    const scores = sample.map((draw) => draw.agreement);

    expect(share(scores, (score) => score >= AGREEMENT_TAIL_AT)).toBeLessThanOrEqual(
      AGREEMENT_TAIL_SHARE_MAX,
    );
    expect(Math.max(...scores)).toBeLessThan(AGREEMENT_WORST_MAX);
  });

  test('knowing the answer buys a template match next to nothing, on any of the seeds', () => {
    const margins = sample.map((draw) => draw.margin);

    expect(median(margins)).toBeLessThan(MARGIN_MEDIAN_MAX);
    expect(share(margins, (edge) => edge >= MARGIN_TAIL_AT)).toBeLessThanOrEqual(
      MARGIN_TAIL_SHARE_MAX,
    );
    expect(Math.max(...margins)).toBeLessThan(MARGIN_WORST_MAX);
  });

  test('there is no whitespace gutter to segment the glyphs on', () => {
    const blanks = sample.map((draw) => draw.blankColumns);

    expect(share(blanks, (count) => count > 0)).toBeLessThanOrEqual(BLANK_SHARE_MAX);
    expect(Math.max(...blanks)).toBeLessThanOrEqual(BLANK_COLUMNS_MAX);
  });

  test('every seed spreads ink far outside the band the straight render sits in', () => {
    const floor = inkedRows(straightInk, width, height) * SPREAD_OVER_STRAIGHT;

    for (const draw of sample) expect(draw.inkedRows).toBeGreaterThan(floor);
  });

  test('the glyphs come in more than one colour family', () => {
    const families = sample.map((draw) => draw.families);

    expect(share(families, (count) => count < 2)).toBeLessThanOrEqual(FAMILY_SHARE_MAX);
  });
});

describe('newCaptchaAnswer', () => {
  test('the alphabet holds no pair a distorted render collapses', () => {
    expect(CAPTCHA_ALPHABET).not.toMatch(/[0O1IL5S2Z]/);
    expect(new Set(CAPTCHA_ALPHABET).size).toBe(CAPTCHA_ALPHABET.length);
  });

  test.each([4, 5, 6, 7, 8])('returns the %i characters it was asked for', (length) => {
    expect(newCaptchaAnswer(length)).toHaveLength(length);
  });

  test.each([0, -1, 1.5, Number.NaN, ANSWER_CEILING + 1, 100])(
    'refuses a length of %p, naming the package, the setting and the bound',
    (length) => {
      const thrown = () => newCaptchaAnswer(length);

      expect(thrown).toThrow(/@proton\/cards/);
      expect(thrown).toThrow(/captchaLength/);
      expect(thrown).toThrow(new RegExp(`1 to ${ANSWER_CEILING}`));
    },
  );

  test('the longest answer it will mint is one renderCaptcha will draw', async () => {
    expect(ANSWER_CEILING).toBeGreaterThan(0);

    const longest = newCaptchaAnswer(ANSWER_CEILING);
    expect(longest).toHaveLength(ANSWER_CEILING);
    expect(readPng(await renderCaptcha({ text: longest })).ihdr).toBe('IHDR');

    expect(() => newCaptchaAnswer(ANSWER_CEILING + 1)).toThrow();
    await expect(renderCaptcha({ text: 'A'.repeat(ANSWER_CEILING + 1) })).rejects.toThrow();
  });

  test('draws only from the alphabet, and from all of it', () => {
    const drawn = Array.from({ length: 400 }, () => newCaptchaAnswer(6)).join('');
    const counts = new Map<string, number>();

    for (const character of drawn) {
      expect(CAPTCHA_ALPHABET).toContain(character);
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    expect(counts.size).toBe(CAPTCHA_ALPHABET.length);

    // 2400 draws, 27 symbols: 89 apiece, sd 9.3. Tighter bounds buy flakes, not sensitivity.
    const seen = [...counts.values()];
    expect(Math.min(...seen)).toBeGreaterThan(30);
    expect(Math.max(...seen)).toBeLessThan(150);
  });

  test('two answers in a row differ', () => {
    expect(newCaptchaAnswer(8)).not.toBe(newCaptchaAnswer(8));
  });
});
