export {
  CARD_IMAGE_HOSTS,
  cardImageHostAllowed,
  discordAvatarUrl,
  type FetchLike,
  HttpImageFetcher,
  type HttpImageFetcherOptions,
  IMAGE_MAX_BYTES,
  IMAGE_TIMEOUT_MS,
  type ImageFetcher,
  imageMimeType,
  isRenderableImage,
  nullImageFetcher,
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
  CARD_SIZES,
  type CardDescriptor,
  type CardDescriptorInput,
  type CardKind,
  type CardSize,
  cardDescriptorSchema,
  type GoodbyeCard,
  goodbyeCardSchema,
  type RankCard,
  rankCardSchema,
  sizeFor,
  type WelcomeCard,
  welcomeCardSchema,
} from './descriptor.ts';
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
