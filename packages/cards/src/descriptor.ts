import { z } from 'zod';
import { imageMimeType, oversizedImage } from './avatar.ts';
import { BADGE_CARD_SIZE, BADGE_ICON_IDS, BADGE_SHAPES } from './design/badges.ts';
import { CARD_PRESETS } from './presets.ts';

const displayName = z
  .string()
  .min(1)
  .max(64)
  .describe('The member’s display name, already resolved — cards never look one up.');

const imageUrl = z.url({ protocol: /^https$/ }).max(2048);

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const cardBase = {
  preset: z.enum(CARD_PRESETS).default('midnight'),
  displayName,
  avatarUrl: imageUrl.optional(),

  accent: hexColour
    .optional()
    .describe('Overrides the preset’s accent. Six-digit hex, as the guild chose it.'),

  backgroundUrl: imageUrl.optional(),
};

export const BADGE_IMAGE_MAX_BYTES = 400 * 1024;

export const BADGE_IMAGE_MAX_SIDE = 1_024;

const BADGE_DATA_URI = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

function decodedLength(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

// atob, not Buffer: this schema is parsed in the dashboard's browser bundle too.
function payloadBytes(payload: string): Uint8Array {
  const binary = atob(payload);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export const badgeImageSchema = z
  .string()
  .max(600_000)
  .superRefine((value, ctx) => {
    const match = BADGE_DATA_URI.exec(value);
    const declared = match?.[1];
    const payload = match?.[2];

    if (declared === undefined || payload === undefined || payload.length % 4 !== 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a badge image must be a base64 data: URI of a PNG, JPEG or GIF',
      });
      return;
    }

    const bytes = decodedLength(payload);
    if (bytes > BADGE_IMAGE_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `the badge image is ${bytes} bytes; a badge carries at most ${BADGE_IMAGE_MAX_BYTES}`,
      });
      return;
    }

    const decoded = payloadBytes(payload);
    const sniffed = imageMimeType(decoded);
    if (sniffed === null) {
      ctx.addIssue({
        code: 'custom',
        message: `the badge image says ${declared}, but its bytes are not a PNG, JPEG or GIF`,
      });
      return;
    }

    if (sniffed !== declared) {
      ctx.addIssue({
        code: 'custom',
        message: `the badge image says ${declared}, but its bytes are ${sniffed}`,
      });
      return;
    }

    const oversized = oversizedImage(decoded, BADGE_IMAGE_MAX_SIDE);
    if (oversized !== null) {
      ctx.addIssue({
        code: 'custom',
        message:
          `the badge image is ${oversized.width}×${oversized.height} pixels; a badge carries at ` +
          `most ${BADGE_IMAGE_MAX_SIDE}×${BADGE_IMAGE_MAX_SIDE}`,
      });
    }
  });

const badgeArt = {
  shape: z.enum(BADGE_SHAPES),
  colour: hexColour,
  icon: z.enum(BADGE_ICON_IDS).optional(),
  image: badgeImageSchema.optional(),
};

export const cardBadgeSchema = z.object(badgeArt);

export const RANK_CARD_BADGES_MAX = 6;

export const rankCardSchema = z
  .object({
    kind: z.literal('rank'),
    ...cardBase,
    level: z.number().int().min(0).max(9999),

    rank: z.number().int().min(1).optional(),

    totalXp: z.number().int().min(0),

    xpIntoLevel: z.number().int().min(0),
    xpForNextLevel: z.number().int().min(1),

    showRank: z.boolean().default(true),
    showPercent: z.boolean().default(true),
    showTotalXp: z.boolean().default(true),

    badges: z.array(cardBadgeSchema).max(RANK_CARD_BADGES_MAX).default([]),
    achievementCount: z.number().int().min(0).optional(),
  })
  .refine((card) => card.xpIntoLevel <= card.xpForNextLevel, {
    path: ['xpIntoLevel'],
    message:
      'progress into the level can’t exceed the level’s span, because a bar wider than its track ' +
      'means a bug in the XP curve',
  });

function greetingCard<K extends 'welcome' | 'goodbye'>(kind: K) {
  return z.object({
    kind: z.literal(kind),
    ...cardBase,
    guildName: z.string().min(1).max(100),

    memberCount: z.number().int().min(0),

    showMemberCount: z.boolean().default(true),
  });
}

export const welcomeCardSchema = greetingCard('welcome');
export const goodbyeCardSchema = greetingCard('goodbye');

export const badgeCardSchema = z.object({ kind: z.literal('badge'), ...badgeArt });

export const cardDescriptorSchema = z.discriminatedUnion('kind', [
  rankCardSchema,
  welcomeCardSchema,
  goodbyeCardSchema,
  badgeCardSchema,
]);

export type CardDescriptor = z.infer<typeof cardDescriptorSchema>;
export type CardDescriptorInput = z.input<typeof cardDescriptorSchema>;
export type RankCard = z.infer<typeof rankCardSchema>;
export type WelcomeCard = z.infer<typeof welcomeCardSchema>;
export type GoodbyeCard = z.infer<typeof goodbyeCardSchema>;
export type BadgeCard = z.infer<typeof badgeCardSchema>;
export type CardBadge = z.infer<typeof cardBadgeSchema>;

export type CardKind = CardDescriptor['kind'];

export interface CardSize {
  width: number;
  height: number;
}

const CARD_SIZE: CardSize = { width: 1100, height: 370 };

export const CARD_SIZES: Record<CardKind, CardSize> = {
  rank: CARD_SIZE,
  welcome: CARD_SIZE,
  goodbye: CARD_SIZE,
  badge: { width: BADGE_CARD_SIZE, height: BADGE_CARD_SIZE },
};

export function sizeFor(card: Pick<CardDescriptor, 'kind'>): CardSize {
  return CARD_SIZES[card.kind];
}
