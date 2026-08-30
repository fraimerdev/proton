import {
  durationStringSchema,
  protonFields,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'tempvc';

export const CHANNEL_NAME_MAX = 100;

export const HUBS_CEILING = 40;

export const VOICE_CHANNEL_TYPE = 2;

export const CATEGORY_CHANNEL_TYPE = 4;

/**
 * What a name template may stand in for. `{user}` is kept as an alias of `{displayName}` because
 * every stored template already uses it and renaming it would rewrite every guild's config.
 */
export const NAME_PLACEHOLDERS = ['{user}', '{displayName}', '{username}', '{userId}'] as const;

export type NamePlaceholder = (typeof NAME_PLACEHOLDERS)[number];

export const OWNER_PLACEHOLDER = '{user}';

export const DEFAULT_NAME_TEMPLATE = `${OWNER_PLACEHOLDER}’s channel`;

/** Who may connect. Enforced with real permission overwrites, never in application logic alone. */
export const PRIVACY_MODES = ['public', 'locked', 'private'] as const;

export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const PRIVACY_LABELS: Record<PrivacyMode, string> = {
  public: 'Public — anyone who can see it may join',
  locked: 'Locked — visible, but only trusted members may join',
  private: 'Private — hidden from everyone but trusted members',
};

/** What happens to a channel whose owner walks out while other people are still in it. */
export const OWNERLESS_MODES = ['claim', 'keep', 'transfer'] as const;

export type OwnerlessMode = (typeof OWNERLESS_MODES)[number];

export const OWNERLESS_LABELS: Record<OwnerlessMode, string> = {
  claim: 'Anyone left inside may claim it',
  keep: 'It keeps running with no owner',
  transfer: 'Hand it to whoever has been in it longest',
};

export const TEMP_ROLE_MODES = ['off', 'owner', 'everyone'] as const;

export type TempRoleMode = (typeof TEMP_ROLE_MODES)[number];

export const TEMP_ROLE_LABELS: Record<TempRoleMode, string> = {
  off: 'Nobody',
  owner: 'The owner only',
  everyone: 'Everyone in the channel',
};

/** Where a new channel's starting overwrites come from before Proton's own are layered on. */
export const PERMISSION_SYNC_MODES = ['off', 'category', 'creator'] as const;

export type PermissionSyncMode = (typeof PERMISSION_SYNC_MODES)[number];

export const PERMISSION_SYNC_LABELS: Record<PermissionSyncMode, string> = {
  off: 'Nothing — start from the category Discord gives it',
  category: 'Copy the destination category’s overwrites',
  creator: 'Copy the creator channel’s overwrites',
};

/** The eleven things an owner can be allowed to do to their own channel. */
export const OWNER_CONTROLS = [
  'rename',
  'limit',
  'privacy',
  'trust',
  'block',
  'invite',
  'kick',
  'region',
  'claim',
  'transfer',
  'delete',
] as const;

export type OwnerControl = (typeof OWNER_CONTROLS)[number];

export const OWNER_CONTROL_LABELS: Record<OwnerControl, string> = {
  rename: 'Rename',
  limit: 'User limit',
  privacy: 'Privacy',
  trust: 'Trust',
  block: 'Block',
  invite: 'Invite',
  kick: 'Kick',
  region: 'Region',
  claim: 'Claim',
  transfer: 'Transfer',
  delete: 'Delete',
};

const allowShape = Object.fromEntries(
  OWNER_CONTROLS.map((control) => [control, z.boolean().default(true)]),
) as Record<OwnerControl, z.ZodDefault<z.ZodBoolean>>;

export const ownerControlsSchema = z.object(allowShape);

export type OwnerControls = z.infer<typeof ownerControlsSchema>;

// A bounded duration, so a typo cannot park a delete a week out or hammer Discord every 50ms.
function boundedDuration(fallback: string, minMs: number, maxMs: number) {
  return durationStringSchema.default(fallback).refine(
    (value) => {
      const ms = tryParseDuration(value);
      return ms !== null && ms >= minMs && ms <= maxMs;
    },
    { message: `must be between ${minMs / 1000}s and ${maxMs / 1000}s` },
  );
}

export const EMPTY_DELETE_DELAY_DEFAULT = '5s';
export const CREATION_COOLDOWN_DEFAULT = '5s';

export const tempVcHubSchema = z.object({
  channelId: snowflakeSchema,

  categoryId: snowflakeSchema.optional(),

  // Per hub, so one creator channel can be taken out of service without deleting its settings.
  enabled: z.boolean().default(true),

  nameTemplate: z
    .string()
    .min(1)
    .max(CHANNEL_NAME_MAX)
    .default(DEFAULT_NAME_TEMPLATE)
    .refine((value) => NAME_PLACEHOLDERS.some((placeholder) => value.includes(placeholder)), {
      message: `a name template needs one of ${NAME_PLACEHOLDERS.join(', ')} in it, or every channel it makes has the same name.`,
    }),

  userLimit: z.number().int().min(0).max(99).default(0),

  bitrate: z.number().int().min(8_000).max(384_000).optional(),

  privacy: z.enum(PRIVACY_MODES).default('public'),

  allow: ownerControlsSchema.default(() => ownerControlsSchema.parse({})),

  ownerlessMode: z.enum(OWNERLESS_MODES).default('claim'),

  temporaryRoleId: snowflakeSchema.optional(),
  temporaryRoleMode: z.enum(TEMP_ROLE_MODES).default('off'),

  interfaceEnabled: z.boolean().default(true),

  autoDeleteEmpty: z.boolean().default(true),

  // Discord emits a burst of voice states when somebody switches channel, and an immediate delete
  // races the rejoin. The delay is re-checked before the channel actually goes.
  emptyDeleteDelay: boundedDuration(EMPTY_DELETE_DELAY_DEFAULT, 0, 5 * 60 * 1000),

  maxChannelsPerUser: z.number().int().min(1).max(10).default(1),

  creationCooldown: boundedDuration(CREATION_COOLDOWN_DEFAULT, 0, 10 * 60 * 1000),

  permissionSync: z.enum(PERMISSION_SYNC_MODES).default('off'),
});

export type TempVcHub = z.infer<typeof tempVcHubSchema>;

export const tempVcHubsSchema = z
  .array(tempVcHubSchema)
  .max(HUBS_CEILING)
  .default([])
  .superRefine((hubs, ctx) => {
    const seen = new Set<string>();

    for (const [index, hub] of hubs.entries()) {
      if (seen.has(hub.channelId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'channelId'],
          message:
            'each creator channel can only be listed once — the second entry would never be used.',
        });
      }
      seen.add(hub.channelId);

      if (hub.temporaryRoleMode !== 'off' && hub.temporaryRoleId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'temporaryRoleId'],
          message: 'pick the role to hand out, or set the temporary role back to nobody.',
        });
      }
    }
  });

const settings = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Does nothing until at least one creator channel is added',
  }),

  ownerCommands: z.boolean().default(true).register(protonFields, {
    label: 'Let owners manage their own channel',
    description:
      'Turns off /voice and the control panel everywhere, whatever each creator channel allows',
  }),

  // Server-wide, not per hub: it exists to keep Proton under Discord's channel-creation rate
  // limit, which is a property of the guild rather than of any one creator channel.
  serverCreationLimit: z.number().int().min(1).max(200).default(30).register(protonFields, {
    label: 'New channels per minute',
    description: 'Discord rate-limits channel creation per server; past this Proton waits',
  }),
};

export const tempVcConfigSchema = z.object({
  ...settings,

  hubs: tempVcHubsSchema,
});

// The form generator refuses arrays of objects by design (PLAN.md §9), so the creator-channel list
// is edited by a bespoke dashboard panel and omitted here rather than crashing the settings page.
export const tempVcFormSchema = z.object(settings);

export type TempVcConfig = z.infer<typeof tempVcConfigSchema>;

export const tempVcDefaultConfig: TempVcConfig = tempVcConfigSchema.parse({});

export const TEMPVC_SCHEMA_VERSION = 2;

/**
 * Every key added in v2 carries a default, so a stored v1 hub — five keys — parses straight into
 * the new shape. The one thing Zod cannot do for us is a hub that was stored without `enabled`
 * meaning "on": that is what the default says, so nothing has to be lifted. Kept as the module's
 * documented migration point so the next reshape has somewhere to go.
 */
export function liftStoredConfig(raw: unknown): unknown {
  return raw;
}

// Only ever fed to the schema to read its defaults back out; the caller replaces it immediately.
const DEFAULTS_PROBE = '00000000000000000';

/**
 * A creator channel the admin has added but not yet pointed at a channel. Built from the schema so
 * the dashboard's idea of a new row cannot drift from what the module actually defaults to.
 */
export function blankHub(): TempVcHub {
  return { ...tempVcHubSchema.parse({ channelId: DEFAULTS_PROBE }), channelId: '' };
}

export function hubFor(config: TempVcConfig, channelId: string | null): TempVcHub | undefined {
  if (channelId === null) return undefined;

  return config.hubs.find((hub) => hub.enabled && hub.channelId === channelId);
}

export function hubById(config: TempVcConfig, channelId: string): TempVcHub | undefined {
  return config.hubs.find((hub) => hub.channelId === channelId);
}

export interface NameFacts {
  displayName: string;
  username: string;
  userId: string;
}

export function renderChannelName(template: string, facts: NameFacts): string {
  const filled = template
    .split('{displayName}')
    .join(facts.displayName)
    .split(OWNER_PLACEHOLDER)
    .join(facts.displayName)
    .split('{username}')
    .join(facts.username)
    .split('{userId}')
    .join(facts.userId)
    .trim();

  // Discord refuses an empty name, and a template of nothing but placeholders can produce one.
  return (filled.length === 0 ? facts.displayName : filled).slice(0, CHANNEL_NAME_MAX);
}

export function allows(hub: TempVcHub, control: OwnerControl): boolean {
  return hub.allow[control];
}

export function delayMsOf(hub: TempVcHub): number {
  return hub.autoDeleteEmpty ? (tryParseDuration(hub.emptyDeleteDelay) ?? 5_000) : 0;
}

export function cooldownMsOf(hub: TempVcHub): number {
  return tryParseDuration(hub.creationCooldown) ?? 5_000;
}
