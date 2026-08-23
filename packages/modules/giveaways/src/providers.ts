import {
  type ConditionProvider,
  type ConditionResult,
  ENTITLEMENT_TIERS,
  entitlementRank,
  type MemberContext,
  type MultiplierProvider,
  type Provider,
  protonFields,
  snowflakeSchema,
  zodToDescriptors,
} from '@proton/core';
import { z } from 'zod';
import { DAY_MS, MODULE_ID } from './config.ts';
import type { GiveawayStore } from './store.ts';

const UNKNOWN: ConditionResult = {
  passed: false,
  indeterminate: {
    humanReason: 'Your giveaway history could not be read just now, so this could not be checked.',
  },
};

// Guild-scoped only. GIVEAWAYS.md §4 also offers `scope: 'template'`, but a ConditionProvider is
// handed a MemberContext and nothing else — it cannot know which giveaway it is being evaluated
// for, so a template scope would quietly behave as a guild one. Left out rather than shipped
// wrong; scoping it needs a giveaway-aware context the provider interface does not have.
const noRecentWinsSchema = z.object({
  days: z.number().int().min(1).max(365).default(7).register(protonFields, {
    label: 'Within the last (days)',
  }),
});

const enteredBeforeSchema = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(3)
    .register(protonFields, { label: 'Entered at least' }),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .register(protonFields, { label: 'Within the last (days)' }),
});

const roleBonusSchema = z.object({
  roleIds: z
    .array(snowflakeSchema)
    .min(1)
    .max(25)
    .register(protonFields, { field: 'role-id', label: 'Roles' }),
  amount: z.number().min(0).max(1000).default(1).register(protonFields, { label: 'Entries' }),
  match: z.enum(['any', 'all']).default('any').register(protonFields, { label: 'Needs' }),
});

const flatAmountSchema = z.object({
  amount: z.number().min(0).max(1000).default(1).register(protonFields, { label: 'Entries' }),
});

const premiumBonusSchema = z.object({
  tier: z.enum(ENTITLEMENT_TIERS).default('plus').register(protonFields, { label: 'From tier' }),
  amount: z.number().min(0).max(1000).default(1).register(protonFields, { label: 'Entries' }),
});

const lossStreakSchema = z.object({
  perLoss: z.number().min(0).max(100).default(1).register(protonFields, {
    label: 'Entries per loss',
  }),
  cap: z.number().min(0).max(1000).default(10).register(protonFields, { label: 'Up to at most' }),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .register(protonFields, { label: 'Counting the last (days)' }),
});

function since(ctx: MemberContext, days: number): Date {
  return new Date(ctx.now.getTime() - days * DAY_MS);
}

export function createGiveawayProviders(store: GiveawayStore): Provider[] {
  const noRecentWins: ConditionProvider<typeof noRecentWinsSchema> = {
    kind: 'condition',
    id: 'giveaways.no_recent_wins',
    moduleId: MODULE_ID,
    label: 'No recent wins',
    description: 'Members who won recently sit this one out.',
    emoji: '\u{1F504}',
    configSchema: noRecentWinsSchema,
    builder: zodToDescriptors(noRecentWinsSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const first = ctxs[0];
      if (!first) return new Map();

      const counts = await store.recentWinCounts(
        first.guildId,
        ctxs.map((ctx) => ctx.userId),
        since(first, config.days),
        null,
      );

      return new Map(
        ctxs.map((ctx) => {
          const current = counts.get(ctx.userId) ?? 0;
          return [
            ctx.userId,
            { passed: current === 0, progress: { current, required: 0, unit: 'wins' } },
          ] as const;
        }),
      );
    },

    describe(config) {
      return `Not have won a giveaway in this server in the last ${config.days} days.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;

      const current = result.progress?.current ?? 0;
      return (
        `You have won ${current} ${current === 1 ? 'giveaway' : 'giveaways'} in the last ` +
        `${config.days} days, so this one is for everybody else.`
      );
    },
  };

  const enteredBefore: ConditionProvider<typeof enteredBeforeSchema> = {
    kind: 'condition',
    id: 'giveaways.entered_before',
    moduleId: MODULE_ID,
    label: 'Entered before',
    description: 'Only members who have taken part in previous giveaways.',
    emoji: '\u{1F3AB}',
    configSchema: enteredBeforeSchema,
    builder: zodToDescriptors(enteredBeforeSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const first = ctxs[0];
      if (!first) return new Map();

      const counts = await store.priorEntryCounts(
        first.guildId,
        ctxs.map((ctx) => ctx.userId),
        since(first, config.days),
      );

      return new Map(
        ctxs.map((ctx) => {
          const current = counts.get(ctx.userId) ?? 0;
          return [
            ctx.userId,
            {
              passed: current >= config.count,
              progress: { current, required: config.count, unit: 'giveaways' },
            },
          ] as const;
        }),
      );
    },

    describe(config) {
      return `Have entered ${config.count} giveaways in the last ${config.days} days.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;

      return (
        `You have entered ${result.progress?.current ?? 0} of ${config.count} giveaways in the ` +
        `last ${config.days} days.`
      );
    },
  };

  const roleBonus: MultiplierProvider<typeof roleBonusSchema> = {
    kind: 'multiplier',
    id: 'giveaways.role_bonus',
    moduleId: MODULE_ID,
    label: 'Role bonus',
    description: 'Members holding a role get extra entries.',
    emoji: '\u{1F3AD}',
    configSchema: roleBonusSchema,
    builder: zodToDescriptors(roleBonusSchema),
    cost: 'facts',

    async evaluate(ctx, config) {
      const held = ctx.member?.roleIds;
      if (!held) return 0;

      const hits = config.roleIds.filter((id) => held.includes(id));
      const matched =
        config.match === 'all' ? hits.length === config.roleIds.length : hits.length > 0;

      return matched ? config.amount : 0;
    },

    describe(config) {
      const roles = config.roleIds.map((id) => `<@&${id}>`).join(', ');
      return `${roles}: ${config.amount} extra entries.`;
    },
  };

  const boosterBonus: MultiplierProvider<typeof flatAmountSchema> = {
    kind: 'multiplier',
    id: 'giveaways.booster_bonus',
    moduleId: MODULE_ID,
    label: 'Booster bonus',
    description: 'Server boosters get extra entries.',
    emoji: '\u{1F48E}',
    configSchema: flatAmountSchema,
    builder: zodToDescriptors(flatAmountSchema),
    cost: 'facts',

    async evaluate(ctx, config) {
      return ctx.member?.premiumSince ? config.amount : 0;
    },

    describe(config) {
      return `Server boosters: ${config.amount} extra entries.`;
    },
  };

  const premiumBonus: MultiplierProvider<typeof premiumBonusSchema> = {
    kind: 'multiplier',
    id: 'giveaways.premium_bonus',
    moduleId: MODULE_ID,
    label: 'Premium server bonus',
    description: 'Everyone gets extra entries while this server is on a paid Proton tier.',
    emoji: '\u{2B50}',
    configSchema: premiumBonusSchema,
    builder: zodToDescriptors(premiumBonusSchema),
    cost: 'facts',

    async evaluate(ctx, config) {
      return entitlementRank(ctx.tier) >= entitlementRank(config.tier) ? config.amount : 0;
    },

    describe(config) {
      return `While this server is on ${config.tier}: ${config.amount} extra entries.`;
    },
  };

  const lossStreak: MultiplierProvider<typeof lossStreakSchema> = {
    kind: 'multiplier',
    id: 'giveaways.loss_streak',
    moduleId: MODULE_ID,
    label: 'Bad luck bonus',
    description: 'Members who keep entering and losing get better odds over time.',
    emoji: '\u{1F340}',
    configSchema: lossStreakSchema,
    builder: zodToDescriptors(lossStreakSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? 0;
    },

    async batchEvaluate(ctxs, config) {
      const first = ctxs[0];
      if (!first) return new Map();

      const userIds = ctxs.map((ctx) => ctx.userId);
      const from = since(first, config.days);

      const [entered, won] = await Promise.all([
        store.priorEntryCounts(first.guildId, userIds, from),
        store.recentWinCounts(first.guildId, userIds, from, null),
      ]);

      return new Map(
        ctxs.map((ctx) => {
          const losses = Math.max(0, (entered.get(ctx.userId) ?? 0) - (won.get(ctx.userId) ?? 0));
          return [ctx.userId, Math.min(losses * config.perLoss, config.cap)] as const;
        }),
      );
    },

    describe(config) {
      return (
        `${config.perLoss} extra entries for every giveaway you entered and did not win in the ` +
        `last ${config.days} days, up to ${config.cap}.`
      );
    },
  };

  return [
    noRecentWins,
    enteredBefore,
    roleBonus,
    boosterBonus,
    premiumBonus,
    lossStreak,
  ] as unknown as Provider[];
}
