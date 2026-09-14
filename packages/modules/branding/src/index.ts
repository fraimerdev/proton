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
import { nameStyleWriteIssues, sameDisplayNameStyle } from './name-style.ts';

export { createBrandingCommand } from './commands.ts';
export {
  BIO_MAX,
  BRANDING_ACTOR,
  BRANDING_SCHEMA_VERSION,
  type BrandingConfig,
  brandingConfigSchema,
  brandingDefaultConfig,
  brandingFormSchema,
  isBlank,
  liftStoredConfig,
  MODULE_ID as BRANDING_MODULE_ID,
  NICKNAME_MAX,
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
export {
  type DisplayNameStyle,
  displayNameStyleSchema,
  hexColourSchema,
  isEffectAvailable,
  isFontAvailable,
  isSendableNameStyle,
  NAME_STYLE_COLOURS,
  NAME_STYLE_DEFAULT_COLOUR,
  NAME_STYLE_EFFECT_CATALOGUE,
  NAME_STYLE_EFFECT_LABELS,
  NAME_STYLE_EFFECTS,
  NAME_STYLE_FONT_CATALOGUE,
  NAME_STYLE_FONT_LABELS,
  NAME_STYLE_FONTS,
  NAME_STYLE_MAX_COLOURS,
  NAME_STYLE_UNAVAILABLE_NOTE,
  type NameStyleEffect,
  type NameStyleEffectEntry,
  type NameStyleFont,
  type NameStyleFontEntry,
  type NameStyleIssue,
  nameStyleWriteIssues,
  parseHexColour,
  sameDisplayNameStyle,
  toHexColour,
  toWireStyle,
  wireStyleFingerprint,
} from './name-style.ts';
export {
  applyNameStyle,
  fetchBotNameStyle,
  type NameStyleVerdict,
  readDisplayNameStyles,
  sameWireStyle,
  UNVERIFIED_RETRY_MS,
  verifyNameStyle,
} from './name-style-apply.ts';
export {
  describeNameStyleStatus,
  fromWireStyle,
  NAME_STYLE_STATUS_STATES,
  type NameStyleStatus,
  type NameStyleStatusState,
  type NameStyleView,
  nameStyleStatusSchema,
  nameStyleViewSchema,
} from './name-style-status.ts';
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

    // An unchanged stored style, even one Discord no longer offers, never blocks saving the rest.
    refineWrite(next, before) {
      return sameDisplayNameStyle(next.displayNameStyle, before.displayNameStyle)
        ? []
        : nameStyleWriteIssues(next.displayNameStyle);
    },

    // Guilds alone. Reconciliation reads the bot's own member off GUILD_CREATE, which arrives
    // under this intent; GuildMembers would only add drift Proton has decided not to chase.
    requiredIntents: [GatewayIntentBits.Guilds],

    // Only the nickname needs a bit, and this one is what the invite asks for. The avatar, banner
    // and bio still land in a guild that has stripped it — the two legs are separate actions.
    requiredPermissions: [Permissions.ChangeNickname],
    // Manage Roles is not required: lacking it only defers deleting the old colour role.
    actionKinds: [
      'set_bot_nickname',
      'set_bot_profile',
      'set_bot_name_style',
      'delete_role',
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
        { id: 'style', title: 'Display name style', fields: ['displayNameStyle'] },
      ],
    },
  };
}

export const brandingModule: ModuleManifest<typeof brandingConfigSchema> = createBrandingModule();

export default brandingModule;
