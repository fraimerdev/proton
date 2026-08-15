import {
  durationStringSchema,
  protonFields,
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

const levelingShape = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Award XP for chatting and for time in voice channels.',
  }),

  xpPerMessageMin: z.number().int().min(0).max(1000).default(15).register(protonFields, {
    label: 'XP per message (minimum)',
    description: 'The low end of the range rolled for each message that earns XP.',
  }),

  xpPerMessageMax: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(25)
    .register(protonFields, {
      label: 'XP per message (maximum)',
      description:
        'The high end of the range. A range rather than a fixed number so the exact ' +
        'message count needed for a level cannot be computed and farmed.',
    }),

  messageCooldown: durationStringSchema.default('60s').register(protonFields, {
    field: 'duration',
    label: 'Message cooldown',
    description:
      'How long after earning XP before a member can earn it again. Shorter rewards ' +
      'flooding; this is the one setting that decides whether the leaderboard measures ' +
      'participation or typing speed.',
  }),

  levelUpMessage: z
    .string()
    .max(500)
    .default(DEFAULT_LEVEL_UP_MESSAGE)
    .register(protonFields, {
      label: 'Level-up message',
      description:
        `Posted when a member levels up. ${LEVEL_UP_PLACEHOLDERS.join(', ')} are replaced. ` +
        'Leave it empty to level members up silently.',
    }),

  levelUpChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Level-up channel',
    description:
      'Where level-up messages go. Left empty, the message is posted in the channel the ' +
      'member was talking in — and a level-up earned in voice is silent, because there is ' +
      'no such channel.',

    channelTypes: [0, 5, 11, 12],
  }),

  excludedChannelIds: z
    .array(snowflakeSchema)
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Excluded channels',
      description: 'Messages in these channels never earn XP — bot-command and spam channels.',
      channelTypes: [0, 5, 11, 12],
    }),

  excludedRoleIds: z
    .array(snowflakeSchema)
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'role-id',
      label: 'Excluded roles',
      description:
        'Members holding any of these roles never earn XP. Usually staff, so the ' +
        'leaderboard measures the community rather than the people moderating it.',
    }),

  voiceXpPerMinute: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(5)
    .register(protonFields, {
      label: 'Voice XP per minute',
      description:
        'XP for each full minute in a voice channel, paid when the member leaves. Set it ' +
        'to 0 to award nothing for voice.',
    }),

  afkChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'AFK channel',
    description:
      'Time in this channel earns nothing. Set it to the server’s AFK channel — otherwise ' +
      'the top of the voice leaderboard is whoever leaves Discord open overnight.',

    channelTypes: [2, 13],
  }),

  rewardMode: z
    .enum(REWARD_MODES)
    .default('stack')
    .register(protonFields, {
      label: 'Reward mode',
      description:
        'Stack keeps every reward role a member has earned. Replace keeps only the newest ' +
        'and removes the ones below it.',
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

export const levelingFormSchema = z.object(levelingShape).omit({ roleRewards: true });

export const levelingDefaultConfig: LevelingConfig = {
  enabled: false,
  xpPerMessageMin: 15,
  xpPerMessageMax: 25,
  messageCooldown: '60s',
  levelUpMessage: DEFAULT_LEVEL_UP_MESSAGE,
  excludedChannelIds: [],
  excludedRoleIds: [],
  voiceXpPerMinute: 5,

  rewardMode: 'stack',
  roleRewards: [],
};

export const LEVELING_SCHEMA_VERSION = 1;

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

export function renderLevelUpMessage(
  template: string,
  values: { userId: string; level: number; xp: number },
): string {
  return template
    .replaceAll('{user}', `<@${values.userId}>`)
    .replaceAll('{level}', String(values.level))
    .replaceAll('{xp}', String(values.xp));
}
