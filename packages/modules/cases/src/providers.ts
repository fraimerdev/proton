import {
  type ConditionProvider,
  type ConditionResult,
  type MemberContext,
  type Provider,
  protonFields,
  zodToDescriptors,
} from '@proton/core';
import { z } from 'zod';
import { CASE_TYPES, type CaseHistoryStore } from './history.ts';

export const CASES_MODULE_ID = 'cases';

const UNKNOWN: ConditionResult = {
  passed: false,
  indeterminate: {
    humanReason:
      'Your moderation history in this server could not be read just now, so this could not ' +
      'be checked.',
  },
};

const typesField = z
  .array(z.enum(CASE_TYPES))
  .min(1)
  .max(CASE_TYPES.length)
  .default(['ban', 'kick', 'timeout', 'warn'])
  .register(protonFields, {
    label: 'Which kinds count',
  });

const noActiveCaseSchema = z.object({ types: typesField });

const noCasesInSchema = z.object({
  days: z.number().int().min(1).max(3650).default(30).register(protonFields, {
    label: 'Within the last (days)',
  }),
  types: typesField,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function listTypes(types: readonly string[]): string {
  return types.join(', ');
}

export function createCasesProviders(history: CaseHistoryStore): Provider[] {
  async function countFor(
    ctxs: readonly MemberContext[],
    types: readonly string[],
    options: { since?: Date; activeAt?: Date },
  ): Promise<Map<string, number>> {
    const first = ctxs[0];
    if (!first) return new Map();

    return history.countByTarget({
      guildId: first.guildId,
      userIds: ctxs.map((ctx) => ctx.userId),
      types,
      ...options,
    });
  }

  const noActiveCase: ConditionProvider<typeof noActiveCaseSchema> = {
    kind: 'condition',
    id: 'cases.no_active_case',
    moduleId: CASES_MODULE_ID,
    label: 'No active moderation',
    description: 'Must not currently be under one of the chosen moderation actions.',
    emoji: '\u{2696}',
    configSchema: noActiveCaseSchema,
    builder: zodToDescriptors(noActiveCaseSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const first = ctxs[0];
      if (!first) return new Map();

      const counts = await countFor(ctxs, config.types, { activeAt: first.now });

      return new Map(
        ctxs.map((ctx) => [ctx.userId, { passed: (counts.get(ctx.userId) ?? 0) === 0 }] as const),
      );
    },

    describe(config) {
      return `Not currently be under moderation (${listTypes(config.types)}).`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;

      return `You are currently under a moderation action (${listTypes(config.types)}) in this server.`;
    },
  };

  const noCasesIn: ConditionProvider<typeof noCasesInSchema> = {
    kind: 'condition',
    id: 'cases.no_cases_in',
    moduleId: CASES_MODULE_ID,
    label: 'Clean recent record',
    description: 'Must not have been moderated in this server recently.',
    emoji: '\u{1F4DC}',
    configSchema: noCasesInSchema,
    builder: zodToDescriptors(noCasesInSchema),
    cost: 'query',

    async evaluate(ctx, config) {
      return (await this.batchEvaluate?.([ctx], config))?.get(ctx.userId) ?? UNKNOWN;
    },

    async batchEvaluate(ctxs, config) {
      const first = ctxs[0];
      if (!first) return new Map();

      const since = new Date(first.now.getTime() - config.days * DAY_MS);
      const counts = await countFor(ctxs, config.types, { since });

      return new Map(
        ctxs.map((ctx) => {
          const current = counts.get(ctx.userId) ?? 0;
          return [
            ctx.userId,
            { passed: current === 0, progress: { current, required: 0, unit: 'cases' } },
          ] as const;
        }),
      );
    },

    describe(config) {
      return `Have no moderation actions (${listTypes(config.types)}) in the last ${config.days} days.`;
    },

    describeFailure(config, result) {
      if (result.indeterminate) return result.indeterminate.humanReason;

      const current = result.progress?.current ?? 0;
      return (
        `You have ${current} moderation ${current === 1 ? 'action' : 'actions'} ` +
        `(${listTypes(config.types)}) in the last ${config.days} days.`
      );
    },
  };

  return [noActiveCase, noCasesIn] as unknown as Provider[];
}
