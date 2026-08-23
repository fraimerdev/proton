import {
  type ConditionProvider,
  type ConditionResult,
  type MemberContext,
  type MultiplierProvider,
  type Provider,
  protonFields,
  zodToDescriptors,
} from '@proton/core';
import { z } from 'zod';
import {
  ACTIVITY_WINDOWS,
  type ActivityStore,
  type ActivityWindow,
  type MemberStats,
} from './activity.ts';

export const LEVELING_MODULE_ID = 'leveling';

const UNKNOWN: ConditionResult = {
  passed: false,
  indeterminate: {
    humanReason:
      'Your activity in this server could not be read just now, so this could not be checked.',
  },
};

const windowField = z
  .enum(ACTIVITY_WINDOWS)
  // 30d, not lifetime: an account that was busy two years ago is not active now, and a lifetime
  // total is the number a farmed account is built to inflate.
  .default('30d')
  .register(protonFields, { label: 'Counted over' });

const minField = (label: string) =>
  z.number().int().min(0).max(10_000_000).default(0).register(protonFields, { label });

function statOf(stats: Map<string, MemberStats>, ctx: MemberContext): MemberStats | null {
  return stats.get(ctx.userId) ?? null;
}

function compare(current: number, required: number, unit: string): ConditionResult {
  return { passed: current >= required, progress: { current, required, unit } };
}

function windowLabel(window: ActivityWindow): string {
  if (window === 'lifetime') return 'in total';
  return window === '7d' ? 'in the last 7 days' : 'in the last 30 days';
}

const levelSchema = z.object({
  min: minField('Minimum level'),
});

const xpSchema = z.object({
  min: minField('Minimum XP'),
});

const messagesSchema = z.object({
  min: minField('Minimum messages'),
  window: windowField,
});

const voiceSchema = z.object({
  min: minField('Minimum voice minutes'),
  window: windowField,
});

const rankSchema = z.object({
  n: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(10)
    .register(protonFields, { label: 'Top how many' }),
});

export function createLevelingProviders(activity: ActivityStore): Provider[] {
  async function statsFor(ctxs: readonly MemberContext[]): Promise<Map<string, MemberStats>> {
    const guildId = ctxs[0]?.guildId;
    if (guildId === undefined) return new Map();

    return activity.stats(
      guildId,
      ctxs.map((ctx) => ctx.userId),
    );
  }

  async function totalsFor(
    ctxs: readonly MemberContext[],
    window: ActivityWindow,
  ): Promise<Map<string, { messageCount: number; voiceSeconds: number }>> {
    const first = ctxs[0];
    if (!first) return new Map();

    return activity.totals({
      guildId: first.guildId,
      userIds: ctxs.map((ctx) => ctx.userId),
      window,
      now: first.now,
    });
  }

  const level: ConditionProvider<typeof levelSchema> = {
    kind: 'condition',
    id: 'leveling.level',
    moduleId: LEVELING_MODULE_ID,
    label: 'Level',
    description: 'Must have reached at least a certain level.',
    emoji: '\u{1F4C8}',
    configSchema: levelSchema,
    builder: zodToDescriptors(levelSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      const results = await this.batchEvaluate?.([ctx], config);
      return results?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const stats = await statsFor(ctxs);

      return new Map(
        ctxs.map((ctx) => {
          const stat = statOf(stats, ctx);
          return [ctx.userId, compare(stat?.level ?? 0, config.min, 'levels')] as const;
        }),
      );
    },

    describe(config) {
      return `Be level ${config.min} or higher.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;
      return `You are level ${result.progress?.current ?? 0} and need level ${config.min}.`;
    },
  };

  const xp: ConditionProvider<typeof xpSchema> = {
    kind: 'condition',
    id: 'leveling.xp',
    moduleId: LEVELING_MODULE_ID,
    label: 'XP',
    description: 'Must have earned at least a certain amount of XP.',
    emoji: '\u{2728}',
    configSchema: xpSchema,
    builder: zodToDescriptors(xpSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      const results = await this.batchEvaluate?.([ctx], config);
      return results?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const stats = await statsFor(ctxs);

      return new Map(
        ctxs.map((ctx) => {
          const stat = statOf(stats, ctx);
          return [ctx.userId, compare(stat?.xp ?? 0, config.min, 'XP')] as const;
        }),
      );
    },

    describe(config) {
      return `Have at least ${config.min} XP.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;
      return `You have ${result.progress?.current ?? 0} XP and need ${config.min}.`;
    },
  };

  const messages: ConditionProvider<typeof messagesSchema> = {
    kind: 'condition',
    id: 'leveling.messages',
    moduleId: LEVELING_MODULE_ID,
    label: 'Messages sent',
    description: 'Must have sent a number of messages, optionally only counting recent ones.',
    emoji: '\u{1F4AC}',
    configSchema: messagesSchema,
    builder: zodToDescriptors(messagesSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      const results = await this.batchEvaluate?.([ctx], config);
      return results?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const totals = await totalsFor(ctxs, config.window);

      return new Map(
        ctxs.map((ctx) => {
          const total = totals.get(ctx.userId);
          return [ctx.userId, compare(total?.messageCount ?? 0, config.min, 'messages')] as const;
        }),
      );
    },

    describe(config) {
      return `Have sent ${config.min} messages ${windowLabel(config.window)}.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;

      return `You have sent ${result.progress?.current ?? 0} of ${config.min} messages ${windowLabel(
        config.window,
      )}.`;
    },
  };

  const voiceMinutes: ConditionProvider<typeof voiceSchema> = {
    kind: 'condition',
    id: 'leveling.voice_minutes',
    moduleId: LEVELING_MODULE_ID,
    label: 'Voice minutes',
    description: 'Must have spent time in voice channels, optionally only counting recent time.',
    emoji: '\u{1F3A4}',
    configSchema: voiceSchema,
    builder: zodToDescriptors(voiceSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      const results = await this.batchEvaluate?.([ctx], config);
      return results?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const totals = await totalsFor(ctxs, config.window);

      return new Map(
        ctxs.map((ctx) => {
          const seconds = totals.get(ctx.userId)?.voiceSeconds ?? 0;
          return [ctx.userId, compare(Math.floor(seconds / 60), config.min, 'minutes')] as const;
        }),
      );
    },

    describe(config) {
      return `Have spent ${config.min} minutes in voice ${windowLabel(config.window)}.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;

      return `You have ${result.progress?.current ?? 0} of ${config.min} voice minutes ${windowLabel(
        config.window,
      )}.`;
    },
  };

  const rankTop: ConditionProvider<typeof rankSchema> = {
    kind: 'condition',
    id: 'leveling.rank_top',
    moduleId: LEVELING_MODULE_ID,
    label: 'Leaderboard rank',
    description: 'Only the top members of the XP leaderboard qualify.',
    emoji: '\u{1F3C6}',
    configSchema: rankSchema,
    builder: zodToDescriptors(rankSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      const results = await this.batchEvaluate?.([ctx], config);
      return results?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const guildId = ctxs[0]?.guildId;
      if (guildId === undefined) return new Map();

      const top = new Set(await activity.topRanked(guildId, config.n));

      return new Map(ctxs.map((ctx) => [ctx.userId, { passed: top.has(ctx.userId) }] as const));
    },

    describe(config) {
      return `Be in the top ${config.n} on the leaderboard.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;
      return `You are not in the top ${config.n} on this server's leaderboard.`;
    },
  };

  // One tier per entry, repeated with mode 'max', rather than an array of {minLevel, amount}:
  // PLAN.md §9 keeps arrays of objects out of the form generator, and 'max' already means
  // "highest matching wins", which is exactly what a tier ladder is.
  const levelTierSchema = z.object({
    minLevel: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(5)
      .register(protonFields, { label: 'From level' }),
    amount: z.number().min(0).max(1000).default(1).register(protonFields, { label: 'Entries' }),
  });

  const levelTier: MultiplierProvider<typeof levelTierSchema> = {
    kind: 'multiplier',
    id: 'leveling.level_tier',
    moduleId: LEVELING_MODULE_ID,
    label: 'Level bonus',
    description: 'Members at or above a level get extra entries. Add one per tier.',
    emoji: '\u{1F4C8}',
    configSchema: levelTierSchema,
    builder: zodToDescriptors(levelTierSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? 0;
    },

    async batchEvaluate(ctxs, config) {
      const stats = await statsFor(ctxs);

      return new Map(
        ctxs.map((ctx) => {
          const level = statOf(stats, ctx)?.level ?? 0;
          return [ctx.userId, level >= config.minLevel ? config.amount : 0] as const;
        }),
      );
    },

    describe(config) {
      return `Level ${config.minLevel} and above: ${config.amount} entries.`;
    },
  };

  const perActivitySchema = z.object({
    per: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(100)
      .register(protonFields, { label: 'For every' }),
    amount: z
      .number()
      .min(0)
      .max(1000)
      .default(1)
      .register(protonFields, { label: 'Entries earned' }),
    cap: z
      .number()
      .min(0)
      .max(10_000)
      .default(10)
      .register(protonFields, { label: 'Up to at most' }),
    window: windowField,
  });

  function perActivity(
    id: string,
    label: string,
    description: string,
    emoji: string,
    unit: string,
    measure: (totals: { messageCount: number; voiceSeconds: number }) => number,
  ): MultiplierProvider<typeof perActivitySchema> {
    return {
      kind: 'multiplier',
      id,
      moduleId: LEVELING_MODULE_ID,
      label,
      description,
      emoji,
      configSchema: perActivitySchema,
      builder: zodToDescriptors(perActivitySchema),
      cost: 'query',

      async evaluate(ctx, config) {
        return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? 0;
      },

      async batchEvaluate(ctxs, config) {
        const totals = await totalsFor(ctxs, config.window);

        return new Map(
          ctxs.map((ctx) => {
            const value = measure(totals.get(ctx.userId) ?? { messageCount: 0, voiceSeconds: 0 });
            const earned = Math.floor(value / config.per) * config.amount;

            return [ctx.userId, Math.min(earned, config.cap)] as const;
          }),
        );
      },

      describe(config) {
        return (
          `${config.amount} entries for every ${config.per} ${unit} ` +
          `${windowLabel(config.window)}, up to ${config.cap}.`
        );
      },
    };
  }

  const perMessages = perActivity(
    'leveling.per_messages',
    'Entries per messages',
    'Extra entries for every so many messages sent.',
    '\u{1F4AC}',
    'messages',
    (totals) => totals.messageCount,
  );

  const perVoiceMinutes = perActivity(
    'leveling.per_voice_minutes',
    'Entries per voice minutes',
    'Extra entries for every so many minutes spent in voice.',
    '\u{1F3A4}',
    'voice minutes',
    (totals) => Math.floor(totals.voiceSeconds / 60),
  );

  return [
    level,
    xp,
    messages,
    voiceMinutes,
    rankTop,
    levelTier,
    perMessages,
    perVoiceMinutes,
  ] as unknown as Provider[];
}
