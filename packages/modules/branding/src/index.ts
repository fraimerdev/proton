import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createBrandingCommand } from './commands.ts';
import {
  BRANDING_SCHEMA_VERSION,
  brandingConfigSchema,
  brandingDefaultConfig,
  brandingFormSchema,
  liftStoredConfig,
} from './config.ts';
import type { BrandingDeps } from './deps.ts';
import { createBrandingListener } from './listeners.ts';

export {
  colourFingerprint,
  coloursFor,
  ENHANCED_COLOURS_HINT,
  type NameEffect,
  ROLE_NAME,
} from './colour.ts';
export { createBrandingCommand } from './commands.ts';
export {
  BIO_MAX,
  BRAND_CYAN,
  BRAND_VIOLET,
  BRANDING_ACTOR,
  BRANDING_SCHEMA_VERSION,
  type BrandingConfig,
  brandingConfigSchema,
  brandingDefaultConfig,
  brandingFormSchema,
  isBlank,
  liftStoredConfig,
  MODULE_ID as BRANDING_MODULE_ID,
} from './config.ts';
export { type BrandingDeps, describeUnbound } from './deps.ts';
export {
  type AcceptedImage,
  acceptImage,
  dataUri,
  type ImageCheck,
  imageMime,
} from './image.ts';
export {
  ACCEPTED_TYPES,
  ASSET_KINDS,
  type AssetKind,
  AVATAR_MAX_BYTES,
  BANNER_MAX_BYTES,
  isAssetKind,
  kilobytes,
  maxBytesFor,
} from './kinds.ts';
export { BRANDING_EVENT_TYPES, createBrandingListener } from './listeners.ts';
export { impersonationReason, normaliseName } from './names.ts';
export {
  CLEARED,
  type DesiredProfile,
  type Divergence,
  desiredProfile,
  diverges,
  fingerprint,
  type ObservedProfile,
  observedProfile,
  readImage,
} from './profile.ts';
export {
  type BrandingAsset,
  type BrandingAssetStore,
  type BrandingRoleStore,
  DrizzleBrandingAssetStore,
  DrizzleBrandingRoleStore,
} from './store.ts';
export {
  type BrandingAssetRow,
  type BrandingRoleRow,
  brandingAssets,
  brandingRoles,
} from './table.ts';
export {
  applyTypeface,
  fitsNickname,
  isTypeface,
  NICKNAME_MAX_UNITS,
  nicknameBudget,
  TYPEFACE_LABELS,
  TYPEFACES,
  type Typeface,
} from './typeface.ts';

export function createBrandingModule(
  deps: BrandingDeps = {},
): ModuleManifest<typeof brandingConfigSchema> {
  return {
    id: 'branding',
    name: 'Branding',
    category: 'utility',
    configSchema: brandingConfigSchema,
    formSchema: brandingFormSchema,
    defaultConfig: brandingDefaultConfig,
    schemaVersion: BRANDING_SCHEMA_VERSION,
    liftStoredConfig,

    // Guilds alone. Reconciliation reads the bot's own member off GUILD_CREATE, which arrives
    // under this intent; GuildMembers would only add drift Proton has decided not to chase.
    requiredIntents: [GatewayIntentBits.Guilds],

    // Only the nickname needs a bit, and this one is what the invite asks for. The avatar, banner
    // and bio still land in a guild that has stripped it — the two legs are separate actions.
    requiredPermissions: [Permissions.ChangeNickname, Permissions.ManageRoles],
    // create_role/edit_role/add_role are the colour half: Discord has no way to colour a bot's
    // name directly, so Proton makes a role, colours it, and wears it.
    actionKinds: [
      'set_bot_nickname',
      'set_bot_profile',
      'create_role',
      'edit_role',
      'add_bot_role',
      'remove_bot_role',
      'interaction_reply',
      'interaction_followup',
    ],

    commands: [createBrandingCommand(deps)],
    listeners: [createBrandingListener(deps)],

    dashboard: {
      icon: 'id-card',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'restoreOnDisable'] },
        { id: 'identity', title: 'Identity', fields: ['nickname', 'bio'] },
        {
          id: 'style',
          title: 'Display name style',
          fields: ['typeface', 'nameEffect', 'primaryColor', 'secondaryColor'],
        },
      ],
    },
  };
}

export const brandingModule: ModuleManifest<typeof brandingConfigSchema> = createBrandingModule();

export default brandingModule;
