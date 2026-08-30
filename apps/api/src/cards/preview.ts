import {
  CARD_PRESETS,
  type CardDescriptorInput,
  HttpImageFetcher,
  type ImageFetcher,
  renderCard,
  PREVIEW_SAMPLE as SAMPLE,
  toHexColour,
} from '@proton/cards';
import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const cardPreviewQuerySchema = z.object({
  kind: z.enum(['rank', 'welcome', 'goodbye']),
  preset: z.enum(CARD_PRESETS).default('midnight'),

  accent: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((value) => value >= 0 && value <= 0xffffff, 'must be a 24-bit colour')
    .optional(),

  background: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),

  displayName: z.string().min(1).max(64).default('Member'),
  guildName: z.string().min(1).max(100).optional(),

  // A URL rather than a user id and a hash: the caller already holds the signed-in user's avatar
  // URL, and the fetcher refuses anything that is not Discord's CDN anyway.
  avatar: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),

  showRank: booleanish,
  showPercent: booleanish,
  showTotalXp: booleanish,
  showMemberCount: booleanish,
});

export type CardPreviewQuery = z.infer<typeof cardPreviewQuerySchema>;

export function previewDescriptor(query: CardPreviewQuery): CardDescriptorInput {
  const shared = {
    preset: query.preset,
    displayName: query.displayName,
    ...(query.accent === undefined ? {} : { accent: toHexColour(query.accent) }),
    ...(query.background === undefined ? {} : { backgroundUrl: query.background }),
    ...(query.avatar === undefined ? {} : { avatarUrl: query.avatar }),
  };

  if (query.kind === 'rank') {
    return {
      kind: 'rank',
      ...shared,
      level: SAMPLE.level,
      rank: SAMPLE.rank,
      totalXp: SAMPLE.totalXp,
      xpIntoLevel: SAMPLE.xpIntoLevel,
      xpForNextLevel: SAMPLE.xpForNextLevel,
      ...(query.showRank === undefined ? {} : { showRank: query.showRank }),
      ...(query.showPercent === undefined ? {} : { showPercent: query.showPercent }),
      ...(query.showTotalXp === undefined ? {} : { showTotalXp: query.showTotalXp }),
    };
  }

  return {
    kind: query.kind,
    ...shared,
    guildName: query.guildName ?? SAMPLE.guildName,
    memberCount: SAMPLE.memberCount,
    ...(query.showMemberCount === undefined ? {} : { showMemberCount: query.showMemberCount }),
  };
}

export interface CardPreviewDeps {
  images?: ImageFetcher;
  render?: (input: CardDescriptorInput, deps: { images?: ImageFetcher }) => Promise<Uint8Array>;
}

export class CardPreviewService {
  readonly #images: ImageFetcher;
  readonly #render: NonNullable<CardPreviewDeps['render']>;

  constructor(deps: CardPreviewDeps = {}) {
    this.#images = deps.images ?? new HttpImageFetcher();
    this.#render = deps.render ?? renderCard;
  }

  async render(query: CardPreviewQuery): Promise<Uint8Array> {
    return this.#render(previewDescriptor(query), { images: this.#images });
  }
}
