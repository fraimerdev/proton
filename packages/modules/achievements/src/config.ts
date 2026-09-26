import { BADGE_ICON_IDS, BADGE_SHAPES } from '@proton/cards/design';
import {
  durationStringSchema,
  interactiveKeys,
  liftLegacyMessage,
  limitFor,
  messageObjectSchema,
  protonFields,
  refineMessage,
  snowflakeSchema,
  TIER_IDS,
  tryParseDuration,
  XP_GRANT_MAX,
  XP_SOURCES,
} from '@proton/core';
import { z } from 'zod';
import { TRIGGER_IDS } from './triggers.ts';

export const MODULE_ID = 'achievements';

export const ACHIEVEMENTS_SCHEMA_VERSION = 1;

export const ACHIEVEMENT_ID = /^[a-z0-9][a-z0-9_-]{2,31}$/;
export const REQUIREMENT_ID = /^[a-z0-9][a-z0-9_-]{0,15}$/;
export const BADGE_ASSET_ID = /^[a-z0-9]{8,40}$/;

export const TIERED_IDS = ['bronze', 'silver', 'gold', 'diamond'] as const;

export type TieredId = (typeof TIERED_IDS)[number];

export const MAX_REQUIREMENTS = 3;
export const MAX_REWARDS_PER_TIER = 5;
export const MAX_TIERS = TIERED_IDS.length;

export const ACHIEVEMENTS_CEILING = limitFor('pro', 'achievements');

export const ACHIEVEMENT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;

export type AchievementStatus = (typeof ACHIEVEMENT_STATUSES)[number];

export const ACHIEVEMENT_KINDS = ['single', 'tiered'] as const;

export type AchievementKind = (typeof ACHIEVEMENT_KINDS)[number];

export const ANNOUNCE_TARGETS = ['current', 'channel', 'dm', 'none'] as const;

export const OVERRIDE_TARGETS = ['current', 'channel', 'dm'] as const;

export const ALMOST_THERE_TARGETS = ['dm', 'current', 'channel'] as const;

export const FALLBACK_TARGETS = ['channel', 'dm', 'none'] as const;

export const ANNOUNCEMENT_MODES = ['default', 'custom', 'off'] as const;

export const MESSAGE_COOLDOWN_MIN = '0s';
export const MESSAGE_COOLDOWN_MAX = '1h';
export const ALMOST_THERE_COOLDOWN_MIN = '1h';
export const ALMOST_THERE_COOLDOWN_MAX = '30d';

export const ALMOST_THERE_PERCENT_MIN = 50;
export const ALMOST_THERE_PERCENT_MAX = 95;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function boundedDuration(min: string, max: string) {
  const minMs = tryParseDuration(min) ?? 0;
  const maxMs = tryParseDuration(max) ?? 0;

  return durationStringSchema.refine(
    (value) => {
      const ms = tryParseDuration(value);
      return ms === null || (ms >= minMs && ms <= maxMs);
    },
    { message: `must be between ${min} and ${max}` },
  );
}

const ID_RULE =
  'lowercase letters, digits, hyphens or underscores, starting with a letter or digit';

export const rewardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_role'), roleId: snowflakeSchema }),
  z.object({ kind: z.literal('remove_role'), roleId: snowflakeSchema }),
  z.object({ kind: z.literal('xp'), amount: z.number().int().min(1).max(XP_GRANT_MAX) }),
]);

export type Reward = z.infer<typeof rewardSchema>;

export const requirementSchema = z.object({
  id: z.string().regex(REQUIREMENT_ID, `must be 1 to 16 ${ID_RULE}`),
  version: z.number().int().min(1).default(1),
  trigger: z.enum(TRIGGER_IDS),
  channelIds: z.array(snowflakeSchema).max(25).default([]),
  excludedChannelIds: z.array(snowflakeSchema).max(25).default([]),
  xpSources: z.array(z.enum(XP_SOURCES)).min(1).max(4).optional(),
  achievementId: z.string().regex(ACHIEVEMENT_ID, `must be 3 to 32 ${ID_RULE}`).optional(),
  tierId: z.enum(TIER_IDS).optional(),
});

export type Requirement = z.infer<typeof requirementSchema>;

export const tierSchema = z.object({
  id: z.enum(TIER_IDS),
  targets: z.record(
    z.string().regex(REQUIREMENT_ID, `must be 1 to 16 ${ID_RULE}`),
    z.number().int().min(1),
  ),
  rewards: z.array(rewardSchema).max(MAX_REWARDS_PER_TIER).default([]),
});

export type Tier = z.infer<typeof tierSchema>;

export const badgeSchema = z.object({
  shape: z.enum(BADGE_SHAPES).default('circle'),
  icon: z.enum(BADGE_ICON_IDS).default('trophy'),
  colour: z.union([z.literal('tier'), z.number().int().min(0).max(0xffffff)]).default('tier'),
  assetId: z.string().regex(BADGE_ASSET_ID).optional(),
});

export type Badge = z.infer<typeof badgeSchema>;

type MessageShape = z.infer<typeof messageObjectSchema>;

export function isSilentMessage(message: MessageShape): boolean {
  return (
    (message.content?.trim().length ?? 0) === 0 &&
    message.embeds.length === 0 &&
    message.components.length === 0 &&
    message.v2.length === 0
  );
}

function refineAnnouncement(message: MessageShape, ctx: z.RefinementCtx): void {
  // An empty message is how a server announces nothing, and refineMessage refuses exactly that.
  if (isSilentMessage(message)) return;
  refineMessage(message, ctx);

  if (interactiveKeys(message).length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['components'],
      message: 'Only link buttons can be used here.',
    });
  }
}

export const announcementMessageSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine(refineAnnouncement),
);

export type AnnouncementMessage = z.infer<typeof announcementMessageSchema>;

export const almostThereMessageSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine(refineAnnouncement),
);

export type AlmostThereMessage = z.infer<typeof almostThereMessageSchema>;

const ANNOUNCEMENT_MENTIONS = { everyone: false, roles: false, users: true };

export const DEFAULT_ANNOUNCEMENT: AnnouncementMessage = {
  content: '{user.mention} earned **{achievement.name}** {achievement.tier_label}',
  embeds: [],
  components: [],
  mentions: ANNOUNCEMENT_MENTIONS,
  v2: [],
};

export const DEFAULT_ALMOST_THERE: AlmostThereMessage = {
  content: 'You’re close to **{achievement.name}** {achievement.tier_label}\n{progress.summary}',
  embeds: [],
  components: [],
  mentions: ANNOUNCEMENT_MENTIONS,
  v2: [],
};

export const announceTargetSchema = z.enum(ANNOUNCE_TARGETS);

export const achievementAnnouncementSchema = z.object({
  mode: z.enum(ANNOUNCEMENT_MODES).default('default'),
  destination: z.enum(OVERRIDE_TARGETS).optional(),
  channelId: snowflakeSchema.optional(),
  message: announcementMessageSchema.optional(),
});

export type AchievementAnnouncement = z.infer<typeof achievementAnnouncementSchema>;

export const achievementSchema = z.object({
  id: z.string().regex(ACHIEVEMENT_ID, `must be 3 to 32 ${ID_RULE}`),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(''),
  status: z.enum(ACHIEVEMENT_STATUSES).default('draft'),
  badge: badgeSchema.prefault({}),
  kind: z.enum(ACHIEVEMENT_KINDS),
  requirements: z.array(requirementSchema).min(1).max(MAX_REQUIREMENTS),
  tiers: z.array(tierSchema).min(1).max(MAX_TIERS),
  roleIds: z.array(snowflakeSchema).max(25).default([]),
  excludedRoleIds: z.array(snowflakeSchema).max(25).default([]),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  includeRecorded: z.boolean().default(false),
  almostThere: z
    .object({
      enabled: z.boolean().default(false),
      percent: z
        .number()
        .int()
        .min(ALMOST_THERE_PERCENT_MIN)
        .max(ALMOST_THERE_PERCENT_MAX)
        .default(80),
    })
    .prefault({}),
  announcement: achievementAnnouncementSchema.prefault({}),
});

export type Achievement = z.infer<typeof achievementSchema>;

export type AchievementInput = z.input<typeof achievementSchema>;

const achievementsShape = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  timezone: z
    .string()
    .refine(isTimeZone, 'Pick a time zone from the list.')
    .default('UTC')
    .register(protonFields, { label: 'Time zone' }),

  excludedChannelIds: z.array(snowflakeSchema).max(50).default([]).register(protonFields, {
    field: 'channel-id',
    label: 'Excluded channels',
  }),

  excludedRoleIds: z.array(snowflakeSchema).max(50).default([]).register(protonFields, {
    field: 'role-id',
    label: 'Excluded roles',
  }),

  messageCooldown: boundedDuration(MESSAGE_COOLDOWN_MIN, MESSAGE_COOLDOWN_MAX)
    .default('15s')
    .register(protonFields, { field: 'duration', label: 'Message cooldown' }),

  announcement: z
    .object({
      destination: announceTargetSchema.default('current'),
      channelId: snowflakeSchema.optional(),
      fallback: z.enum(FALLBACK_TARGETS).default('none'),
      fallbackChannelId: snowflakeSchema.optional(),
      attachBadge: z.boolean().default(true),
      message: announcementMessageSchema.default(DEFAULT_ANNOUNCEMENT),
    })
    .prefault({}),

  almostThere: z
    .object({
      destination: z.enum(ALMOST_THERE_TARGETS).default('dm'),
      channelId: snowflakeSchema.optional(),
      cooldown: boundedDuration(ALMOST_THERE_COOLDOWN_MIN, ALMOST_THERE_COOLDOWN_MAX).default('1d'),
      message: almostThereMessageSchema.default(DEFAULT_ALMOST_THERE),
    })
    .prefault({}),

  achievements: z.array(achievementSchema).max(ACHIEVEMENTS_CEILING).default([]),
};

export const achievementsConfigSchema = z.object(achievementsShape);

export type AchievementsConfig = z.infer<typeof achievementsConfigSchema>;

export type AchievementsConfigInput = z.input<typeof achievementsConfigSchema>;

export const achievementsFormSchema = z.object(achievementsShape).pick({
  enabled: true,
  timezone: true,
  excludedChannelIds: true,
  excludedRoleIds: true,
  messageCooldown: true,
});

export const achievementsDefaultConfig: AchievementsConfig = achievementsConfigSchema.parse({});
