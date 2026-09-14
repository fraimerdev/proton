import { NICKNAME_MAX, protonFields } from '@proton/core';
import { z } from 'zod';
import { displayNameStyleSchema } from './name-style.ts';

export { NICKNAME_MAX } from '@proton/core';

export const MODULE_ID = 'branding';

export const BRANDING_ACTOR = 'proton:branding';

export const BRANDING_SCHEMA_VERSION = 3;

// Discord documents no maximum for a guild member bio. 190 is what its own client enforces, so an
// over-long bio is refused here with a sentence the admin can act on rather than by the API with a
// 400 that names a field they never typed.
export const BIO_MAX = 190;

// Not admin-editable and not in the form: the upload route writes them, and their only job is to
// change when the image does, so a save reconciles and the fingerprint sees a new picture.
const assetHash = z.string().max(64).optional();

const editable = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  nickname: z
    .string()
    .min(1)
    .max(NICKNAME_MAX)
    .optional()
    .register(protonFields, {
      label: 'Server nickname',
      description: `Leave empty to use Proton’s own name. Up to ${NICKNAME_MAX} characters.`,
    }),

  bio: z
    .string()
    .max(BIO_MAX)
    .optional()
    .register(protonFields, {
      label: 'Server bio',
      description: `Shown as “About me” on Proton’s profile. Up to ${BIO_MAX} characters.`,
    }),

  displayNameStyle: displayNameStyleSchema.nullable().default(null),

  restoreOnDisable: z.boolean().default(true).register(protonFields, {
    label: 'Reset when switched off',
    description: 'Remove the server nickname, avatar, banner, bio and display name style.',
  }),
};

export const brandingConfigSchema = z.object({
  ...editable,
  avatarHash: assetHash,
  bannerHash: assetHash,
  nameStyleNative: z.boolean().optional(),
});

// The images are uploaded through their own control, not typed into a text box, so the generated
// form renders everything except the two hashes.
export const brandingFormSchema = z.object(editable);

export type BrandingConfig = z.infer<typeof brandingConfigSchema>;

export const brandingDefaultConfig: BrandingConfig = brandingConfigSchema.parse({});

const RETIRED_DEFAULT_COLOUR = 0x2a8af7;

function isRetiredDefaultStyle(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;

  const { font, effect, colours, ...extra } = value as Record<string, unknown>;
  return (
    font === 'gg-sans' &&
    effect === 'solid' &&
    Array.isArray(colours) &&
    colours.length === 1 &&
    colours[0] === RETIRED_DEFAULT_COLOUR &&
    Object.keys(extra).length === 0
  );
}

// Retired keys (v1 image URLs, look-alike typeface, role colour) are dropped here, not by Zod.
export function liftStoredConfig(raw: unknown, current?: Record<string, unknown>): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;

  const {
    avatarUrl: _avatarUrl,
    bannerUrl: _bannerUrl,
    typeface: _typeface,
    nameEffect: _nameEffect,
    primaryColor: _primaryColor,
    secondaryColor: _secondaryColor,
    ...rest
  } = raw as Record<string, unknown>;

  if (current !== undefined) return { ...rest, nameStyleNative: true };

  const style = rest.displayNameStyle;
  if (style === undefined || style === null) return rest;

  // Only an unstamped row can hold the preview build's default; a stamped one chose that style.
  const retired = rest.nameStyleNative !== true && isRetiredDefaultStyle(style);
  // An unreadable stored style reads as none, or it would make every Branding setting unreadable.
  if (retired || !displayNameStyleSchema.safeParse(style).success) {
    return { ...rest, displayNameStyle: null };
  }

  return rest;
}

export function isBlank(config: BrandingConfig): boolean {
  return (
    config.nickname === undefined &&
    config.avatarHash === undefined &&
    config.bannerHash === undefined &&
    config.bio === undefined &&
    config.displayNameStyle === null
  );
}
