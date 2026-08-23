import { z } from 'zod';
import { CARD_PRESETS } from './presets.ts';

const displayName = z
  .string()
  .min(1)
  .max(64)
  .describe('The member’s display name, already resolved — cards never look one up.');

const imageUrl = z.url({ protocol: /^https$/ }).max(2048);

const cardBase = {
  preset: z.enum(CARD_PRESETS).default('midnight'),
  displayName,
  avatarUrl: imageUrl.optional(),

  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe('Overrides the preset’s accent. Six-digit hex, as the guild chose it.'),

  backgroundUrl: imageUrl.optional(),
};

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
  })
  .refine((card) => card.xpIntoLevel <= card.xpForNextLevel, {
    path: ['xpIntoLevel'],
    message:
      'progress into the level cannot exceed the level’s span — a bar wider than its track is a ' +
      'curve bug upstream, so it is refused here rather than clamped and hidden',
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

export const cardDescriptorSchema = z.discriminatedUnion('kind', [
  rankCardSchema,
  welcomeCardSchema,
  goodbyeCardSchema,
]);

export type CardDescriptor = z.infer<typeof cardDescriptorSchema>;
export type CardDescriptorInput = z.input<typeof cardDescriptorSchema>;
export type RankCard = z.infer<typeof rankCardSchema>;
export type WelcomeCard = z.infer<typeof welcomeCardSchema>;
export type GoodbyeCard = z.infer<typeof goodbyeCardSchema>;

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
};

export function sizeFor(kind: CardKind): CardSize {
  return CARD_SIZES[kind];
}
