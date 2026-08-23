export {
  discordAvatarUrl,
  type FetchLike,
  HttpImageFetcher,
  type HttpImageFetcherOptions,
  IMAGE_MAX_BYTES,
  IMAGE_TIMEOUT_MS,
  type ImageFetcher,
  isRenderableImage,
  nullImageFetcher,
} from './avatar.ts';
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
export { accentOf, type CardImages, CORNER_RADIUS, drawCard, highlightOf } from './draw.ts';
export {
  FALLBACK_FONT_FAMILY,
  FONT_FAMILY,
  FONT_LICENCE,
  FONT_STACK,
  registeredFamilies,
  registerFonts,
} from './fonts.ts';
export {
  CARD_PRESETS,
  type CardPreset,
  PRESET_PALETTES,
  type PresetPalette,
  paletteFor,
  toHexColour,
} from './presets.ts';
export { type CardDeps, renderCard } from './render.ts';
export { abbreviate, group, monogram, sanitiseText } from './text.ts';
