import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import type { CardDescriptor, GoodbyeCard, RankCard, WelcomeCard } from './descriptor.ts';
import { FONT_STACK } from './fonts.ts';
import { type PresetPalette, paletteFor } from './presets.ts';
import { abbreviate, group, monogram, sanitiseText } from './text.ts';

export const CORNER_RADIUS = 50;

const AVATAR_X = 67;
const AVATAR_Y = 83;
const AVATAR_RADIUS = 108;
const AVATAR_RING = 7;

const CONTENT_LEFT = 320;
const CONTENT_RIGHT = 1010;

const BAR_Y = 280;
const BAR_THICKNESS = 50;
const BAR_LEFT = 310;
const BAR_RIGHT = CONTENT_RIGHT;

const TRACK_COLOUR = '#4d4d4d';

const MEDALS = ['#ffd700', '#c0c0c0', '#cd7f32'];

// A guild's own image is whatever they uploaded, and white 44px text over a bright photo is
// unreadable. The scrim is what keeps every preset legible on top of any background.
const BACKDROP_SCRIM_ALPHA = 0.62;

export interface CardImages {
  avatar: Image | null;
  background: Image | null;
}

export function accentOf(card: CardDescriptor, palette: PresetPalette): string {
  return card.accent ?? palette.accent;
}

// The medal outranks the guild's accent, and only on the podium: a gold bar is the whole point of
// being first, and it reads as gold precisely because ranks 4 and down are not.
export function highlightOf(card: CardDescriptor, palette: PresetPalette): string {
  if (card.kind === 'rank' && card.rank !== undefined && card.rank <= MEDALS.length) {
    return MEDALS[card.rank - 1] ?? accentOf(card, palette);
  }

  return accentOf(card, palette);
}

const ELLIPSIS = '…';

// Discord allows 32-character names and guilds allow 100, either of which will run into whatever
// sits to its right. The size steps down first because a smaller whole name beats a truncated one.
function fitted(
  ctx: SKRSContext2D,
  value: string,
  maxWidth: number,
  font: { max: number; min: number; weight?: 'bold' },
): string {
  const face = font.weight ? `${font.weight} ` : '';

  for (let size = font.max; size >= font.min; size -= 2) {
    ctx.font = `${face}${size}px ${FONT_STACK}`;
    if (ctx.measureText(value).width <= maxWidth) return value;
  }

  let kept = value;
  while (kept.length > 1 && ctx.measureText(kept + ELLIPSIS).width > maxWidth) {
    kept = kept.slice(0, -1);
  }

  return kept + ELLIPSIS;
}

function roundedPath(ctx: SKRSContext2D, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h);
  ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
}

// Cover, not stretch: a guild's background is whatever they had to hand, and squashing a 16:9
// screenshot into a 1100x370 frame is the difference between a card and a smear.
function coverRect(image: Image, w: number, h: number): [number, number, number, number] {
  const scale = Math.max(w / image.width, h / image.height);
  const drawn: [number, number] = [image.width * scale, image.height * scale];
  return [(w - drawn[0]) / 2, (h - drawn[1]) / 2, drawn[0], drawn[1]];
}

function paintBackdrop(
  ctx: SKRSContext2D,
  palette: PresetPalette,
  accent: string,
  background: Image | null,
  w: number,
  h: number,
): void {
  const wash = ctx.createLinearGradient(0, 0, w, h);
  wash.addColorStop(0, palette.background);
  wash.addColorStop(1, palette.surface);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  if (background) {
    ctx.drawImage(background, ...coverRect(background, w, h));

    ctx.globalAlpha = BACKDROP_SCRIM_ALPHA;
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  const glow = ctx.createRadialGradient(w, 0, 0, w, 0, w * 0.6);
  glow.addColorStop(0, `${accent}33`);
  glow.addColorStop(1, `${accent}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

function drawAvatar(
  ctx: SKRSContext2D,
  avatar: Image | null,
  displayName: string,
  palette: PresetPalette,
): void {
  const centreX = AVATAR_X + AVATAR_RADIUS;
  const centreY = AVATAR_Y + AVATAR_RADIUS;
  const size = AVATAR_RADIUS * 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(centreX, centreY, AVATAR_RADIUS, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (avatar) {
    const [dx, dy, dw, dh] = coverRect(avatar, size, size);
    ctx.drawImage(avatar, AVATAR_X + dx, AVATAR_Y + dy, dw, dh);
  } else {
    ctx.fillStyle = palette.accentSoft;
    ctx.fillRect(AVATAR_X, AVATAR_Y, size, size);
    ctx.fillStyle = palette.text;
    ctx.font = `bold ${Math.round(size * 0.42)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(monogram(displayName), centreX, centreY);
  }

  ctx.restore();

  ctx.beginPath();
  ctx.arc(centreX, centreY, AVATAR_RADIUS, 0, Math.PI * 2);
  ctx.closePath();
  ctx.lineWidth = AVATAR_RING;
  // Not white: the ring is white on every dark preset, but white on parchment is an invisible ring.
  ctx.strokeStyle = palette.text;
  ctx.stroke();
}

function drawBar(ctx: SKRSContext2D, ratio: number, accent: string): void {
  const length = BAR_RIGHT - BAR_LEFT;

  ctx.lineCap = 'round';
  ctx.lineWidth = BAR_THICKNESS;

  ctx.beginPath();
  ctx.strokeStyle = TRACK_COLOUR;
  ctx.moveTo(BAR_LEFT, BAR_Y);
  ctx.lineTo(BAR_RIGHT, BAR_Y);
  ctx.stroke();
  ctx.closePath();

  if (ratio <= 0) return;

  ctx.beginPath();
  ctx.strokeStyle = accent;
  ctx.moveTo(BAR_LEFT, BAR_Y);
  ctx.lineTo(BAR_LEFT + length * ratio, BAR_Y);
  ctx.stroke();
  ctx.closePath();
}

function drawRank(ctx: SKRSContext2D, card: RankCard, images: CardImages): void {
  const palette = paletteFor(card.preset);
  const accent = highlightOf(card, palette);
  const ratio = Math.min(1, Math.max(0, card.xpIntoLevel / card.xpForNextLevel));

  ctx.textBaseline = 'alphabetic';

  if (card.showRank && card.rank !== undefined) {
    const value = abbreviate(card.rank);
    ctx.font = `44px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = accent;
    ctx.fillText(value, CONTENT_RIGHT, 80);

    ctx.fillStyle = palette.muted;
    ctx.fillText('Rank', CONTENT_RIGHT - ctx.measureText(value).width - 14, 80);
  }

  const level = `Level ${group(card.level)}`;
  ctx.font = `44px ${FONT_STACK}`;
  ctx.fillStyle = palette.text;
  ctx.textAlign = 'right';
  ctx.fillText(level, CONTENT_RIGHT, 220);

  const room = CONTENT_RIGHT - CONTENT_LEFT - ctx.measureText(level).width - 32;
  const name = fitted(ctx, sanitiseText(card.displayName), room, {
    max: 44,
    min: 30,
    weight: 'bold',
  });
  ctx.textAlign = 'left';
  ctx.fillText(name, CONTENT_LEFT, 220);

  if (card.showTotalXp) {
    ctx.font = `26px ${FONT_STACK}`;
    ctx.fillStyle = palette.muted;
    ctx.textAlign = 'left';
    ctx.fillText(`${group(card.totalXp)} XP total`, CONTENT_LEFT, 160);
  }

  drawBar(ctx, ratio, accent);

  if (card.showPercent) {
    ctx.font = `bold 30px ${FONT_STACK}`;
    ctx.fillStyle = palette.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.floor(ratio * 100)}%`, (BAR_LEFT + BAR_RIGHT) / 2, BAR_Y);
  }

  drawAvatar(ctx, images.avatar, card.displayName, palette);
}

const GREETING_COPY = {
  welcome: {
    eyebrow: 'WELCOME',
    line: (guild: string) => `joined ${guild}`,
    tally: (count: number) => `Member #${group(count)}`,
  },
  goodbye: {
    eyebrow: 'GOODBYE',
    line: (guild: string) => `left ${guild}`,
    tally: (count: number) => (count === 1 ? '1 member remains' : `${group(count)} members remain`),
  },
} as const;

function drawPill(ctx: SKRSContext2D, label: string, palette: PresetPalette, accent: string): void {
  ctx.font = `bold 28px ${FONT_STACK}`;
  const width = ctx.measureText(label).width + 56;
  const height = 62;
  const x = CONTENT_RIGHT - width;
  const y = BAR_Y - height / 2;

  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.closePath();
  ctx.fillStyle = palette.surface;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = accent;
  ctx.stroke();

  ctx.fillStyle = palette.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + width / 2, y + height / 2);
}

function drawGreeting(
  ctx: SKRSContext2D,
  card: WelcomeCard | GoodbyeCard,
  images: CardImages,
): void {
  const palette = paletteFor(card.preset);
  const accent = accentOf(card, palette);
  const copy = GREETING_COPY[card.kind];

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  ctx.font = `bold 30px ${FONT_STACK}`;
  ctx.fillStyle = accent;
  ctx.fillText(copy.eyebrow.split('').join(' '), CONTENT_LEFT, 110);

  const room = CONTENT_RIGHT - CONTENT_LEFT;

  ctx.fillStyle = palette.text;
  ctx.fillText(
    fitted(ctx, sanitiseText(card.displayName), room, { max: 56, min: 34, weight: 'bold' }),
    CONTENT_LEFT,
    190,
  );

  ctx.fillStyle = palette.muted;
  ctx.fillText(
    fitted(ctx, sanitiseText(copy.line(card.guildName), copy.line('this server')), room, {
      max: 34,
      min: 24,
    }),
    CONTENT_LEFT,
    240,
  );

  if (card.showMemberCount) drawPill(ctx, copy.tally(card.memberCount), palette, accent);

  drawAvatar(ctx, images.avatar, card.displayName, palette);
}

export function drawCard(
  ctx: SKRSContext2D,
  card: CardDescriptor,
  images: CardImages,
  size: { width: number; height: number },
): void {
  const palette = paletteFor(card.preset);

  roundedPath(ctx, size.width, size.height, CORNER_RADIUS);
  ctx.clip();

  paintBackdrop(ctx, palette, accentOf(card, palette), images.background, size.width, size.height);

  switch (card.kind) {
    case 'rank':
      drawRank(ctx, card, images);
      return;
    case 'welcome':
    case 'goodbye':
      drawGreeting(ctx, card, images);
      return;
  }
}
