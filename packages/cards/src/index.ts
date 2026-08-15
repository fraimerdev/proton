export {
  AVATAR_MAX_BYTES,
  AVATAR_TIMEOUT_MS,
  type AvatarFetcher,
  discordAvatarUrl,
  type FetchLike,
  HttpAvatarFetcher,
  type HttpAvatarFetcherOptions,
  nullAvatarFetcher,
  toDataUri,
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
export { FONT_FAMILY, FONT_LICENCE, type LoadedFont, loadFonts } from './fonts.ts';
export { buildLayout, type CardNode, monogram, sanitiseText } from './layout.ts';
export {
  CARD_PRESETS,
  type CardPreset,
  PRESET_PALETTES,
  type PresetPalette,
  paletteFor,
} from './presets.ts';
export {
  type CardDeps,
  renderCard,
  renderCardSvg,
  resvgRasteriser,
  type SvgRasteriser,
} from './render.ts';
