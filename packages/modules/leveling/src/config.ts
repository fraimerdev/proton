import {
  durationStringSchema,
  protonFields,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';
import { MAX_LEVEL } from './curve.ts';

/**
 * What happens to the reward roles a member already earned when they earn
 * another one.
 *
 * `stack` keeps every reward: the member wears their whole history. `replace`
 * keeps only the newest, which is what a guild wants when the rewards are a
 * single visible ladder ("Member → Regular → Veteran") rather than a collection.
 * There is no third mode, because every other behaviour anyone asks for is one
 * of these two plus a role the guild manages itself.
 */
export const REWARD_MODES = ['stack', 'replace'] as const;

export type RewardMode = (typeof REWARD_MODES)[number];

/**
 * A role granted at a level.
 *
 * Several rewards may share a level — a guild handing out a colour and a
 * permission role at level 10 is ordinary — so the pair, not the level, is what
 * has to be unique. `replace` mode is defined against that: it grants *every*
 * reward at the highest level reached and revokes every reward below it, which
 * stays well defined when a level carries two roles.
 */
export const roleRewardSchema = z.object({
  level: z.number().int().min(1).max(MAX_LEVEL),
  roleId: snowflakeSchema,
});

export type RoleReward = z.infer<typeof roleRewardSchema>;

function uniquePairs(rewards: readonly RoleReward[]): boolean {
  const seen = new Set(rewards.map((reward) => `${reward.level}:${reward.roleId}`));
  return seen.size === rewards.length;
}

/**
 * Exported so the dashboard's bespoke rewards editor validates against the same
 * rules the module enforces on save (§9), rather than growing its own copy that
 * eventually disagrees — the argument `cases` makes for its escalation ladder.
 */
export const roleRewardsSchema = z
  .array(roleRewardSchema)
  .max(50)
  .refine(uniquePairs, {
    message:
      'the same role cannot be listed twice at the same level — one of the two entries would ' +
      'never do anything.',
  });

/**
 * The message posted when a member levels up.
 *
 * Placeholders rather than a template language: a guild writes one sentence, and
 * anything richer belongs to the rank card (§8, slice 3.C).
 */
export const LEVEL_UP_PLACEHOLDERS = ['{user}', '{level}', '{xp}'] as const;

export const DEFAULT_LEVEL_UP_MESSAGE = '{user} reached level {level}.';

const levelingShape = {
  /**
   * Off until a guild asks for it.
   *
   * Leveling is not a safety feature, it is a product decision about what a
   * server rewards — and switching it on for every guild that installs Proton
   * would start writing a per-member behavioural profile (§6, and R7's GDPR
   * note) that nobody asked for. A module that says it is off is honest in a way
   * one that quietly starts counting is not.
   */
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

  /**
   * The cooldown, which is what makes this a chat-activity metric rather than a
   * message counter. Enforced in SQL — see `MemberXpStore.award`.
   */
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
    // Text and announcement channels, plus public and private threads.
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
    // Voice and stage channels.
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

  /**
   * Deliberately not registered with `protonFields`: it is an array of objects,
   * which §9 puts explicitly outside the v1 form generator's vocabulary, and a
   * metadata hint would only make the generator's refusal look like a bug rather
   * than the documented boundary it is. `levelingFormSchema` omits it and a
   * bespoke editor renders it, exactly as `cases` does with its ladder.
   */
  roleRewards: roleRewardsSchema.default([]),
};

/**
 * Leveling configuration.
 *
 * The whole object is validated on every read and write (I5), so a guild that
 * saved a minimum above its maximum in some earlier build is refused at the door
 * rather than silently reinterpreted at award time.
 */
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

  // Excluding the level-up channel is not a contradiction worth refusing — a
  // guild may well want announcements in a channel nobody earns XP in — so the
  // only cross-field rule is the range above. Resist adding more: every one is a
  // save an admin cannot make and a reason they have to be told.
});

export type LevelingConfig = z.infer<typeof levelingConfigSchema>;

/**
 * The subset the dashboard's form generator can build (§9).
 *
 * Derived by omission rather than written out a second time, so a field added to
 * the config appears on the form automatically and the two cannot drift.
 * Omitting `roleRewards` here is a promise that a bespoke editor renders it; the
 * registry enforces that every key named here exists in the config schema.
 */
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
  // Stack by default: it takes nothing away. A default that removed roles would
  // make enabling the module a bulk role change nobody asked for (§15).
  rewardMode: 'stack',
  roleRewards: [],
};

/** Bumped whenever the shape above changes (I5). */
export const LEVELING_SCHEMA_VERSION = 1;

export interface LevelingSettings {
  messageCooldownMs: number;
}

export type SettingsResult = { settings: LevelingSettings } | { invalid: string };

/**
 * Turn the authored duration into the milliseconds the cooldown works in.
 *
 * The schema already refuses an unparseable duration, so `invalid` should be
 * unreachable — but a handler must not throw on a row written by an older build:
 * an exception inside a listener leaves the bus message unacknowledged and the
 * same poison event is redelivered forever. Naming the field beats a stack trace
 * nobody can act on.
 */
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

/**
 * Roll the XP for one message.
 *
 * Random within the configured range, which is the point: a fixed award makes
 * the message count for the next level exactly computable, and a leaderboard
 * whose next rung is a known number of messages away is a leaderboard people
 * type gibberish at. `random` is injectable so tests are deterministic.
 */
export function rollMessageXp(config: LevelingConfig, random: () => number = Math.random): number {
  const min = Math.min(config.xpPerMessageMin, config.xpPerMessageMax);
  const max = Math.max(config.xpPerMessageMin, config.xpPerMessageMax);
  return min + Math.floor(random() * (max - min + 1));
}

/** Fill the level-up template. Unknown text is left exactly as the guild wrote it. */
export function renderLevelUpMessage(
  template: string,
  values: { userId: string; level: number; xp: number },
): string {
  return template
    .replaceAll('{user}', `<@${values.userId}>`)
    .replaceAll('{level}', String(values.level))
    .replaceAll('{xp}', String(values.xp));
}
