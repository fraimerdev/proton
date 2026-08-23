import { z } from 'zod';
import { zodToDescriptors } from '../../src/config/descriptor.ts';
import type {
  ConditionProvider,
  MemberContext,
  ModuleAvailability,
  MultiplierProvider,
  ProviderCost,
} from '../../src/providers/types.ts';

export const GUILD = '100000000000000000';
export const ROLE_A = '600000000000000000';
export const ROLE_B = '600000000000000001';

export const NOW = new Date('2026-08-14T12:00:00.000Z');

export function userIdAt(createdAt: Date): string {
  return String((BigInt(createdAt.getTime() - 1_420_070_400_000) << 22n) | 1n);
}

export const USER_A = userIdAt(new Date('2020-01-01T00:00:00.000Z'));
export const USER_B = userIdAt(new Date('2026-08-01T00:00:00.000Z'));

export function memberContext(overrides: Partial<MemberContext> = {}): MemberContext {
  return {
    guildId: GUILD,
    userId: USER_A,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds: [],
      premiumSince: null,
      communicationDisabledUntil: null,
      ...(overrides.member ?? {}),
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free',
    now: NOW,
    ...overrides,
  };
}

export interface CountingCondition {
  provider: ConditionProvider;
  calls: { batch: number; single: number; sizes: number[] };
}

const countedSchema = z.object({ min: z.number().int().default(0) });

export function countingCondition(
  id: string,
  moduleId: string,
  options: {
    cost?: ProviderCost;
    batch?: boolean;
    passes?: (ctx: MemberContext, min: number) => boolean;
  } = {},
): CountingCondition {
  const calls = { batch: 0, single: 0, sizes: [] as number[] };
  const passes = options.passes ?? (() => true);

  const provider: ConditionProvider<typeof countedSchema> = {
    kind: 'condition',
    id,
    moduleId,
    label: id,
    description: `counting condition ${id}`,
    configSchema: countedSchema,
    builder: zodToDescriptors(countedSchema),
    cost: options.cost ?? 'facts',

    async evaluate(ctx, config) {
      calls.single += 1;
      return { passed: passes(ctx, config.min) };
    },

    ...(options.batch === false
      ? {}
      : {
          async batchEvaluate(ctxs, config) {
            calls.batch += 1;
            calls.sizes.push(ctxs.length);

            return new Map(
              ctxs.map((ctx) => [ctx.userId, { passed: passes(ctx, config.min) }] as const),
            );
          },
        }),

    describe(config) {
      return `${id} at least ${config.min}.`;
    },

    describeFailure(config, result) {
      return result.indeterminate?.humanReason ?? `${id} needs at least ${config.min}.`;
    },
  };

  return { provider: provider as unknown as ConditionProvider, calls };
}

const amountSchema = z.object({ amount: z.number().default(0) });

export function fixedMultiplier(
  id: string,
  moduleId: string,
  amountFor: (ctx: MemberContext, amount: number) => number = (_ctx, amount) => amount,
): MultiplierProvider {
  const provider: MultiplierProvider<typeof amountSchema> = {
    kind: 'multiplier',
    id,
    moduleId,
    label: id,
    description: `multiplier ${id}`,
    configSchema: amountSchema,
    builder: zodToDescriptors(amountSchema),
    cost: 'facts',

    async evaluate(ctx, config) {
      return amountFor(ctx, config.amount);
    },

    describe(config) {
      return `${id} gives ${config.amount}.`;
    },
  };

  return provider as unknown as MultiplierProvider;
}

export function availability(enabled: Record<string, boolean>): ModuleAvailability {
  return {
    async isEnabled(_guildId, moduleId) {
      return enabled[moduleId] ?? false;
    },
  };
}
