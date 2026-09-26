import {
  BADGE_ICON_IDS,
  BADGE_SHAPES,
  CARD_PRESETS,
  type CardDescriptorInput,
  HttpImageFetcher,
  type ImageFetcher,
  renderCard,
  PREVIEW_SAMPLE as SAMPLE,
  TIER_COLOURS,
  toHexColour,
} from '@proton/cards';
import { z } from 'zod';

const counted = z
  .string()
  .regex(/^\d{1,12}$/)
  .transform(Number);

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const colour = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((value) => value >= 0 && value <= 0xffffff, 'must be a 24-bit colour');

export const cardPreviewQuerySchema = z.object({
  kind: z.enum(['rank', 'welcome', 'goodbye', 'badge']),
  preset: z.enum(CARD_PRESETS).default('midnight'),

  accent: colour.optional(),

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
  showBadges: booleanish,

  // Supplied by a simulation, which knows the server's real numbers; absent everywhere else, where
  // the sample's are what a settings preview wants. Both paths render through this one descriptor,
  // so a test message and its preview are the same bytes.
  memberCount: counted.optional(),
  level: counted.optional(),
  rank: counted.optional(),
  totalXp: counted.optional(),
  xpIntoLevel: counted.optional(),
  xpForNextLevel: counted.optional(),

  shape: z.enum(BADGE_SHAPES).default('circle'),
  icon: z.enum(BADGE_ICON_IDS).default('trophy'),
  colour: colour.optional(),
  assetId: z
    .string()
    .regex(/^[a-z0-9]{8,40}$/)
    .optional(),
});

export type CardPreviewQuery = z.infer<typeof cardPreviewQuerySchema>;

export function previewDescriptor(
  query: CardPreviewQuery,
  badgeImage?: string,
): CardDescriptorInput {
  if (query.kind === 'badge') {
    return {
      kind: 'badge',
      shape: query.shape,
      colour: toHexColour(query.colour ?? TIER_COLOURS.single),
      icon: query.icon,
      ...(badgeImage === undefined ? {} : { image: badgeImage }),
    };
  }

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
      level: query.level ?? SAMPLE.level,
      rank: query.rank ?? SAMPLE.rank,
      totalXp: query.totalXp ?? SAMPLE.totalXp,
      xpIntoLevel: query.xpIntoLevel ?? SAMPLE.xpIntoLevel,
      xpForNextLevel: query.xpForNextLevel ?? SAMPLE.xpForNextLevel,
      ...(query.showRank === undefined ? {} : { showRank: query.showRank }),
      ...(query.showPercent === undefined ? {} : { showPercent: query.showPercent }),
      ...(query.showTotalXp === undefined ? {} : { showTotalXp: query.showTotalXp }),
      ...(query.showBadges
        ? { badges: [...SAMPLE.badges], achievementCount: SAMPLE.achievementCount }
        : {}),
    };
  }

  return {
    kind: query.kind,
    ...shared,
    guildName: query.guildName ?? SAMPLE.guildName,
    memberCount: query.memberCount ?? SAMPLE.memberCount,
    ...(query.showMemberCount === undefined ? {} : { showMemberCount: query.showMemberCount }),
  };
}

export interface CardPreviewDeps {
  images?: ImageFetcher;
  render?: (input: CardDescriptorInput, deps: { images?: ImageFetcher }) => Promise<Uint8Array>;
  // null once the asset is pruned: the badge draws its icon instead, as the real announcement does.
  badgeImage?: (guildId: string, assetId: string) => Promise<string | null>;
}

export class CardPreviewService {
  readonly #images: ImageFetcher;
  readonly #render: NonNullable<CardPreviewDeps['render']>;
  readonly #badgeImage: CardPreviewDeps['badgeImage'];

  constructor(deps: CardPreviewDeps = {}) {
    this.#images = deps.images ?? new HttpImageFetcher();
    this.#render = deps.render ?? renderCard;
    this.#badgeImage = deps.badgeImage;
  }

  async render(guildId: string, query: CardPreviewQuery): Promise<Uint8Array> {
    const image =
      query.kind === 'badge' && query.assetId !== undefined && this.#badgeImage
        ? ((await this.#badgeImage(guildId, query.assetId)) ?? undefined)
        : undefined;

    return this.#render(previewDescriptor(query, image), { images: this.#images });
  }
}
