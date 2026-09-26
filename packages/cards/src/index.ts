export {
  CARD_IMAGE_HOSTS,
  cardImageHostAllowed,
  discordAvatarUrl,
  type FetchLike,
  HttpImageFetcher,
  type HttpImageFetcherOptions,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  IMAGE_TIMEOUT_MS,
  type ImageFetcher,
  type ImageSize,
  imageDimensions,
  imageMimeType,
  isRenderableImage,
  nullImageFetcher,
  oversizedImage,
} from './avatar.ts';
export {
  CAPTCHA_ALPHABET,
  type CaptchaDeps,
  type CaptchaInput,
  captchaInputSchema,
  newCaptchaAnswer,
  renderCaptcha,
} from './captcha.ts';
export {
  BADGE_IMAGE_MAX_BYTES,
  BADGE_IMAGE_MAX_SIDE,
  type BadgeCard,
  badgeCardSchema,
  badgeImageSchema,
  CARD_SIZES,
  type CardBadge,
  type CardDescriptor,
  type CardDescriptorInput,
  type CardKind,
  type CardSize,
  cardBadgeSchema,
  cardDescriptorSchema,
  type GoodbyeCard,
  goodbyeCardSchema,
  RANK_CARD_BADGES_MAX,
  type RankCard,
  rankCardSchema,
  sizeFor,
  type WelcomeCard,
  welcomeCardSchema,
} from './descriptor.ts';
export { BadgeArt, type BadgeArtProps } from './design/badge.tsx';
export {
  BADGE_CARD_SIZE,
  BADGE_ICON_IDS,
  BADGE_ICON_LABELS,
  BADGE_ICON_PATHS,
  BADGE_SHAPE_LABELS,
  BADGE_SHAPE_PATHS,
  BADGE_SHAPES,
  type BadgeIconId,
  type BadgeShape,
  CARD_TIER_IDS,
  type CardTierId,
  TIER_COLOURS,
  TIER_LABELS,
} from './design/badges.ts';
export { Card, type CardImages, type CardProps } from './design/card.tsx';
export { PREVIEW_SAMPLE } from './design/sample.ts';
export {
  AVATAR_SIZE,
  CARD_HEIGHT,
  CARD_WIDTH,
  CORNER_RADIUS,
  FALLBACK_FONT_FAMILY,
  FONT_FAMILY,
  FONT_STACK,
  FONT_WEIGHTS,
  type FontWeight,
  withAlpha,
} from './design/tokens.ts';
export { registerFonts, type SatoriFont, satoriFonts } from './fonts.ts';
export {
  CARD_PRESETS,
  type CardPreset,
  DEFAULT_CARD_ACCENT,
  PRESET_PALETTES,
  type PresetPalette,
  paletteFor,
  toHexColour,
} from './presets.ts';
export { type CardDeps, renderCard, renderSvg } from './render.tsx';
export { abbreviate, group, monogram, sanitiseText } from './text.ts';
