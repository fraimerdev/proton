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

export const LEVEL_UP_PLACEHOLDERS = ['{user}', '{level}', '{xp}'] as const;

export const DEFAULT_LEVEL_UP_MESSAGE = '{user} reached level {level}.';

export function liftLevelUpMessage(value: unknown): unknown {
  return typeof value === 'string' ? { content: value } : liftLegacyMessage(value);
}

const NO_INTERACTIVE =
  'a level-up message can carry link buttons and nothing else: Proton does not watch for presses ' +
  'on a level-up announcement, so any other button would do nothing when a member pressed it. ' +
  'Make it a link button, or post the interactive message with the Embeds module instead.';

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
    label: 'XP per message (minimum)',
  }),

  xpPerMessageMax: z.number().int().min(0).max(1000).default(25).register(protonFields, {
    label: 'XP per message (maximum)',
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
      description: 'Colours the progress bar, the rank number and the avatar ring',
    }),

  cardBackgroundUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional()
    .register(protonFields, {
      label: 'Background image',
      description: 'Only images hosted on Discord’s CDN load',
    }),

  cardShowRank: z.boolean().default(true).register(protonFields, {
    label: 'Show the rank number',
  }),

  cardShowPercent: z.boolean().default(true).register(protonFields, {
    label: 'Show progress percentage',
  }),

  cardShowTotalXp: z.boolean().default(true).register(protonFields, { label: 'Show total XP' }),

  levelUpMessage: levelUpMessageSchema.default(DEFAULT_LEVEL_UP),

  levelUpChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Level-up channel',
    description: 'Empty posts in the member’s channel, silencing voice level-ups',
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
    label: 'Voice XP per minute',
    description: 'Credited when the member leaves the voice channel, not during',
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

export const levelingFormSchema = z
  .object(levelingShape)
  .omit({ levelUpMessage: true, roleRewards: true });

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
