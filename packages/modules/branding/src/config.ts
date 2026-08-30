import { NICKNAME_MAX, protonFields } from '@proton/core';
import { z } from 'zod';
import { TYPEFACES } from './typeface.ts';

export const MODULE_ID = 'branding';

export const BRANDING_ACTOR = 'proton:branding';

export const BRANDING_SCHEMA_VERSION = 3;

// Discord documents no maximum for a guild member bio. 190 is what its own client enforces, so an
// over-long bio is refused here with a sentence the admin can act on rather than by the API with a
// 400 that names a field they never typed.
export const BIO_MAX = 190;

// Proton's own gradient, from DESIGN.md. Its middle stop is dropped rather than approximated: a
// Discord role gradient takes two colours, so cyan and violet are the ends of the same ramp and
// the blue between them is simply not expressible.
export const BRAND_CYAN = 0x0ab9fe;
export const BRAND_VIOLET = 0x5944ec;

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
      description: `What Proton is called in this server. Up to ${NICKNAME_MAX} characters; leave it empty to use its own name.`,
    }),

  bio: z
    .string()
    .max(BIO_MAX)
    .optional()
    .register(protonFields, {
      label: 'Server bio',
      description: `The "About me" on Proton's profile in this server. Up to ${BIO_MAX} characters.`,
    }),

  typeface: z.enum(TYPEFACES).default('none').register(protonFields, {
    label: 'Typeface',
    description:
      'Discord has no font setting a bot can use, so a styled name is spelled in Unicode letters that look like one. Members can still mention Proton, but searching the member list for its plain name stops finding it, and screen readers read the letters out one at a time.',
  }),

  nameEffect: z
    .enum(['none', 'solid', 'gradient', 'holographic'])
    .default('none')
    .register(protonFields, {
      label: 'Effect',
      description:
        'Colours Proton’s name through a role it holds here. Gradient and holographic need the server to have Discord’s Enhanced Role Colours feature.',
    }),

  primaryColor: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .default(BRAND_CYAN)
    .register(protonFields, { field: 'colour', label: 'First colour' }),

  secondaryColor: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .default(BRAND_VIOLET)
    .register(protonFields, { field: 'colour', label: 'Second colour' }),

  restoreOnDisable: z.boolean().default(true).register(protonFields, {
    label: 'Undo when switched off',
    description:
      'Clears the nickname, avatar, banner and bio in this server when this module is turned off',
  }),
};

export const brandingConfigSchema = z.object({
  ...editable,
  avatarHash: assetHash,
  bannerHash: assetHash,
});

// The images are uploaded through their own control, not typed into a text box, so the generated
// form renders everything except the two hashes.
export const brandingFormSchema = z.object(editable);

export type BrandingConfig = z.infer<typeof brandingConfigSchema>;

export const brandingDefaultConfig: BrandingConfig = brandingConfigSchema.parse({});

// v1 stored avatarUrl and bannerUrl, images fetched from the Discord CDN rather than uploaded. Zod
// would strip both silently and the next sidebar toggle — which sends no config — would persist the
// stripped object, so the drop is made explicit here instead of being a side effect.
export function liftStoredConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;

  const { avatarUrl: _avatarUrl, bannerUrl: _bannerUrl, ...rest } = raw as Record<string, unknown>;

  return rest;
}

export function isBlank(config: BrandingConfig): boolean {
  return (
    config.nameEffect === 'none' &&
    config.nickname === undefined &&
    config.avatarHash === undefined &&
    config.bannerHash === undefined &&
    config.bio === undefined
  );
}
