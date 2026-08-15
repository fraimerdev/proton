/**
 * Card rendering (PLAN.md §8, docs/PHASE-3.md §3.C).
 *
 * A package, not a module: it registers nothing, subscribes to nothing and holds
 * no per-guild config, so a module importing it is not the cross-module import
 * I3 forbids. `leveling` and `welcome` both draw cards and neither may import the
 * other — this is where the shared half lives.
 *
 * docs/PHASE-3.md G8 recorded the rendering decision as "in `apps/worker`". It
 * lands here instead, and the reason is the same one that put it in the worker:
 * only one process should own a rasteriser. A package that the worker constructs
 * keeps that true while letting the renderer be unit-tested without booting a bus
 * consumer, and §3.C's own slice heading already says `packages/cards`.
 */
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
