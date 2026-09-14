// /presets, not the barrel: the barrel reaches @napi-rs/canvas, a native addon that the
// dashboard's bundler cannot load. Config is read in the browser.
import { CARD_PRESETS, DEFAULT_CARD_ACCENT } from '@proton/cards/presets';
import {
  DEFAULT_MENTION_POLICY,
  durationStringSchema,
  interactiveKeys,
  liftLegacyMessage,
  messageObjectSchema,
  protonFields,
  refineMessage,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';
import { MAX_LEVEL } from './curve.ts';

export const REWARD_MODES = ['stack', 'replace'] as const;

export type RewardMode = (typeof REWARD_MODES)[number];

export const roleRewardSchema = z.object({
  level: z.number().int().min(1).max(MAX_LEVEL),
  roleId: snowflakeSchema,
});

export type RoleReward = z.infer<typeof roleRewardSchema>;

function uniquePairs(rewards: readonly RoleReward[]): boolean {
  const seen = new Set(rewards.map((reward) => `${reward.level}:${reward.roleId}`));
  return seen.size === rewards.length;
}

export const roleRewardsSchema = z
  .array(roleRewardSchema)
  .max(50)
  .refine(uniquePairs, {
    message:
      'the same role cannot be listed twice at the same level — one of the two entries would ' +
      'never do anything.',
  });

export const XP_MULTIPLIER_MIN = 0;
export const XP_MULTIPLIER_MAX = 5;
export const XP_MULTIPLIER_STEP = 0.1;
export const XP_MULTIPLIER_LIST_MAX = 50;

export const MULTIPLIER_CHANNEL_TYPES = [0, 2, 4, 5, 13, 15, 16];

// A tolerance, not a remainder: 0.3 / 0.1 is 2.9999999999999996 in floating point.
function onStep(value: number): boolean {
  const steps = value / XP_MULTIPLIER_STEP;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

const STEP_MESSAGE = 'must be a multiple of 0.1 — for example 0.5, 1.5 or 2';

export const xpMultiplierSchema = z
  .number()
  .min(XP_MULTIPLIER_MIN)
  .max(XP_MULTIPLIER_MAX)
  .refine(onStep, { message: STEP_MESSAGE });

export const roleMultiplierSchema = z.object({
  roleId: snowflakeSchema.clone().register(protonFields, { field: 'role-id', label: 'Role' }),
  multiplier: xpMultiplierSchema.clone().register(protonFields, { label: 'Multiplier' }),
});

export type RoleMultiplier = z.infer<typeof roleMultiplierSchema>;

export const channelMultiplierSchema = z.object({
  channelId: snowflakeSchema.clone().register(protonFields, {
    field: 'channel-id',
    label: 'Channel',
    channelTypes: MULTIPLIER_CHANNEL_TYPES,
  }),
  multiplier: xpMultiplierSchema.clone().register(protonFields, { label: 'Multiplier' }),
});

export type ChannelMultiplier = z.infer<typeof channelMultiplierSchema>;

function repeatedIndexes(ids: readonly string[]): number[] {
  const seen = new Set<string>();
  const repeated: number[] = [];

  ids.forEach((id, index) => {
    if (seen.has(id)) repeated.push(index);
    seen.add(id);
  });

  return repeated;
}

export const roleMultipliersSchema = z
  .array(roleMultiplierSchema)
  .max(XP_MULTIPLIER_LIST_MAX)
  .superRefine((entries, ctx) => {
    for (const index of repeatedIndexes(entries.map((entry) => entry.roleId))) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'roleId'],
        message:
          'this role already has a multiplier — a role has one, so remove one of the two entries.',
      });
    }
  });

export const channelMultipliersSchema = z
  .array(channelMultiplierSchema)
  .max(XP_MULTIPLIER_LIST_MAX)
  .superRefine((entries, ctx) => {
    for (const index of repeatedIndexes(entries.map((entry) => entry.channelId))) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'channelId'],
        message:
          'this channel already has a multiplier — a channel has one, so remove one of the two ' +
          'entries.',
      });
    }
  });

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const XP_EVENT_MAX_PENDING = 5;
export const XP_EVENT_MIN_DURATION_MS = 10 * MINUTE_MS;
export const XP_EVENT_MAX_DURATION_MS = 14 * DAY_MS;
export const XP_EVENT_MAX_LEAD_MS = 30 * DAY_MS;
export const XP_EVENT_MULTIPLIER_MIN = 0.1;
export const XP_EVENT_MULTIPLIER_MAX = 5;

// A start a few minutes behind the server clock is a browser clock, not an attempt to backdate.
export const XP_EVENT_START_GRACE_MS = 5 * MINUTE_MS;

export const XP_EVENT_RETENTION_MS = 7 * DAY_MS;

export const XP_EVENT_STATUSES = ['active', 'scheduled'] as const;

export type XpEventStatus = (typeof XP_EVENT_STATUSES)[number];

export const xpEventMultiplierSchema = z
  .number()
  .min(XP_EVENT_MULTIPLIER_MIN)
  .max(XP_EVENT_MULTIPLIER_MAX)
  .refine(onStep, { message: STEP_MESSAGE });

export const xpEventCreateSchema = z.object({
  multiplier: xpEventMultiplierSchema,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});

export type XpEventCreate = z.infer<typeof xpEventCreateSchema>;

export type XpEventBoundsIssue = { path: 'startsAt' | 'endsAt'; message: string };

export function xpEventBoundsIssue(
  window: { startsAt: number; endsAt: number },
  now: number,
): XpEventBoundsIssue | null {
  if (!Number.isFinite(window.startsAt)) return { path: 'startsAt', message: 'is not a date' };
  if (!Number.isFinite(window.endsAt)) return { path: 'endsAt', message: 'is not a date' };

  if (window.startsAt < now - XP_EVENT_START_GRACE_MS) {
    return {
      path: 'startsAt',
      message: 'is in the past — an XP event can start now or later, never earlier',
    };
  }

  if (window.startsAt - now > XP_EVENT_MAX_LEAD_MS) {
    return {
      path: 'startsAt',
      message: 'is more than 30 days away — an XP event can be scheduled at most 30 days ahead',
    };
  }

  const duration = window.endsAt - window.startsAt;

  if (duration < XP_EVENT_MIN_DURATION_MS) {
    return { path: 'endsAt', message: 'must be at least 10 minutes after the start' };
  }

  if (duration > XP_EVENT_MAX_DURATION_MS) {
    return { path: 'endsAt', message: 'must be at most 14 days after the start' };
  }

  return null;
}

export function xpEventCreateSchemaAt(now: number) {
  return xpEventCreateSchema.superRefine((input, ctx) => {
    const issue = xpEventBoundsIssue(
      { startsAt: Date.parse(input.startsAt), endsAt: Date.parse(input.endsAt) },
      now,
    );

    if (issue) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  });
}

export const xpEventViewSchema = z.object({
  id: z.string().min(1),
  multiplier: xpEventMultiplierSchema,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  status: z.enum(XP_EVENT_STATUSES),
});

export type XpEventView = z.infer<typeof xpEventViewSchema>;

export const LEVEL_UP_PLACEHOLDERS = ['{user}', '{level}', '{xp}'] as const;

export const DEFAULT_LEVEL_UP_MESSAGE = '{user} reached level {level}.';

export function liftLevelUpMessage(value: unknown): unknown {
  return typeof value === 'string' ? { content: value } : liftLegacyMessage(value);
}

const NO_INTERACTIVE =
  'a level-up message can carry link buttons and nothing else: Proton does not watch for presses ' +
  'on a level-up announcement, so any other button would do nothing when a member pressed it. ' +
  'Make it a link button, or post the interactive message with the Messages module instead.';

export function isSilentLevelUp(message: {
  content?: string | undefined;
  embeds: readonly unknown[];
  components: readonly unknown[];
  v2?: readonly unknown[] | undefined;
}): boolean {
  return (
    (message.content?.trim().length ?? 0) === 0 &&
    message.embeds.length === 0 &&
    message.components.length === 0 &&
    (message.v2?.length ?? 0) === 0
  );
}

export const levelUpMessageSchema = z.preprocess(
  liftLevelUpMessage,
  messageObjectSchema.superRefine((message, ctx) => {
    // A message with nothing in it is how a server levels members up silently, and refineMessage
    // rejects exactly that — so it only sees a message that is meant to be posted.
    if (isSilentLevelUp(message)) return;
    refineMessage(message, ctx);

    if (interactiveKeys(message).length > 0) {
      ctx.addIssue({ code: 'custom', path: ['components'], message: NO_INTERACTIVE });
    }
  }),
);

export type LevelUpMessage = z.infer<typeof levelUpMessageSchema>;

export const DEFAULT_LEVEL_UP: LevelUpMessage = {
  content: DEFAULT_LEVEL_UP_MESSAGE,
  embeds: [],
  components: [],
  mentions: DEFAULT_MENTION_POLICY,
  v2: [],
};

const levelingShape = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  xpPerMessageMin: z.number().int().min(0).max(1000).default(15).register(protonFields, {
    label: 'Minimum XP per message',
  }),

  xpPerMessageMax: z.number().int().min(0).max(1000).default(25).register(protonFields, {
    label: 'Maximum XP per message',
  }),

  messageCooldown: durationStringSchema.default('60s').register(protonFields, {
    field: 'duration',
    label: 'Message cooldown',
  }),

  rankCard: z.boolean().default(false).register(protonFields, { label: 'Rank card' }),

  cardPreset: z.enum(CARD_PRESETS).default('midnight').register(protonFields, {
    label: 'Card style',
  }),

  cardAccent: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .default(DEFAULT_CARD_ACCENT)
    .register(protonFields, {
      field: 'colour',
      label: 'Accent colour',
      description: 'Colours the progress bar, rank number and avatar ring.',
    }),

  cardBackgroundUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional()
    .register(protonFields, {
      label: 'Background image',
      description: 'Only images hosted on Discord’s CDN load.',
    }),

  cardShowRank: z.boolean().default(true).register(protonFields, {
    label: 'Show rank number',
  }),

  cardShowPercent: z.boolean().default(true).register(protonFields, {
    label: 'Show progress percentage',
  }),

  cardShowTotalXp: z.boolean().default(true).register(protonFields, { label: 'Show total XP' }),

  levelUpMessage: levelUpMessageSchema.default(DEFAULT_LEVEL_UP),

  levelUpChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Level-up channel',
    description:
      'Where Proton announces new levels. Voice level-ups are announced only when a channel is set.',
    channelTypes: [0, 5, 11, 12],
  }),

  excludedChannelIds: z
    .array(snowflakeSchema)
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Excluded channels',
      channelTypes: [0, 5, 11, 12],
    }),

  excludedRoleIds: z.array(snowflakeSchema).max(50).default([]).register(protonFields, {
    field: 'role-id',
    label: 'Excluded roles',
  }),

  voiceXpPerMinute: z.number().int().min(0).max(100).default(5).register(protonFields, {
    label: 'Voice XP',
    description:
      'XP earned for each minute in voice. Proton adds it when the member leaves the channel.',
  }),

  afkChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'AFK channel',
    channelTypes: [2, 13],
  }),

  rewardMode: z.enum(REWARD_MODES).default('stack').register(protonFields, {
    label: 'Reward mode',
  }),

  roleRewards: roleRewardsSchema.default([]),

  roleMultipliers: roleMultipliersSchema.default([]).register(protonFields, {
    label: 'Role multipliers',
    description:
      'Scale the XP members with these roles earn, from 0× (no XP at all) to 5×. When several ' +
      'multipliers apply, the highest wins — unless one of them is 0×.',
  }),

  channelMultipliers: channelMultipliersSchema.default([]).register(protonFields, {
    label: 'Channel multipliers',
    description:
      'Scale the XP earned in these channels and their threads. A category covers every channel ' +
      'in it.',
  }),
};

export const levelingConfigSchema = z.object(levelingShape).superRefine((config, ctx) => {
  if (config.xpPerMessageMin > config.xpPerMessageMax) {
    ctx.addIssue({
      code: 'custom',
      path: ['xpPerMessageMin'],
      message:
        `must not exceed the maximum (${config.xpPerMessageMax}) — the two bounds are a range ` +
        'to roll inside, and an inverted one describes no range at all.',
    });
  }
});

export type LevelingConfig = z.infer<typeof levelingConfigSchema>;

export const levelingFormSchema = z.object(levelingShape).omit({
  levelUpMessage: true,
  roleRewards: true,
  roleMultipliers: true,
  channelMultipliers: true,
});

export const levelingDefaultConfig: LevelingConfig = {
  enabled: false,
  xpPerMessageMin: 15,
  rankCard: false,
  cardPreset: 'midnight',
  cardAccent: DEFAULT_CARD_ACCENT,
  cardShowRank: true,
  cardShowPercent: true,
  cardShowTotalXp: true,
  xpPerMessageMax: 25,
  messageCooldown: '60s',
  levelUpMessage: DEFAULT_LEVEL_UP,
  excludedChannelIds: [],
  excludedRoleIds: [],
  voiceXpPerMinute: 5,

  rewardMode: 'stack',
  roleRewards: [],
  roleMultipliers: [],
  channelMultipliers: [],
};

export const LEVELING_SCHEMA_VERSION = 4;

export interface LevelingSettings {
  messageCooldownMs: number;
}

export type SettingsResult = { settings: LevelingSettings } | { invalid: string };

export function readSettings(config: LevelingConfig): SettingsResult {
  const messageCooldownMs = tryParseDuration(config.messageCooldown);

  if (messageCooldownMs === null) {
    return {
      invalid:
        'Leveling is enabled but its stored configuration is unreadable: ' +
        `messageCooldown='${config.messageCooldown}'. It must be a number followed by s, m, h, ` +
        'd or w — fix it on the Leveling page of the Proton dashboard.',
    };
  }

  return { settings: { messageCooldownMs } };
}

export function rollMessageXp(config: LevelingConfig, random: () => number = Math.random): number {
  const min = Math.min(config.xpPerMessageMin, config.xpPerMessageMax);
  const max = Math.max(config.xpPerMessageMin, config.xpPerMessageMax);
  return min + Math.floor(random() * (max - min + 1));
}
