import type { z } from 'zod';
import type { FieldDescriptor } from '../config/descriptor.ts';
import type { EntitlementTier } from '../rules/facts.ts';

export interface MemberContext {
  guildId: string;
  userId: string;

  // null means the member could not be loaded at all — they left, or the Server Members intent is
  // absent. An empty roleIds array would read as "holds no roles", which fails role-lacks OPEN and
  // enters somebody the host excluded on purpose.
  member: {
    joinedAt: Date | null;
    roleIds: string[] | null;
    premiumSince: Date | null;
    communicationDisabledUntil: Date | null;

    /** The per-guild nickname, not the account name. Null means "not carried", not "not set". */
    nickname?: string | null;
  } | null;

  user: {
    createdAt: Date;
    hasAvatar: boolean | null;
    bot: boolean;

    // Discord retired discriminators: `username` is the unique handle and `globalName` is the
    // display name, which is what a member actually sees. Null means the payload did not carry it,
    // so a name check reports indeterminate rather than matching against an empty string.
    username?: string | null;
    globalName?: string | null;
  };

  // A guild fact, not a member one, but it is constant across a batch and both is_premium and
  // premium_bonus judge a member by it — carrying it here is one read instead of one per provider.
  tier: EntitlementTier;

  // Built from a gateway dispatch, which carries roles and little else. A null date here means
  // "not carried", not "not set", so a provider reading one must report indeterminate and let the
  // caller decide whether loading the real member is worth a round trip.
  partial?: boolean;

  now: Date;
}

export interface ConditionProgress {
  current: number;
  required: number;
  unit: string;
}

export interface ConditionResult {
  passed: boolean;

  progress?: ConditionProgress;

  // Judged nothing, as opposed to judged and said no. Callers must not read this as a failure the
  // member can act on — it names a missing intent or an absent fact.
  indeterminate?: { humanReason: string };
}

export type ProviderCost = 'facts' | 'query';

export type ProviderSchema = z.ZodObject<z.ZodRawShape>;

interface ProviderBase<C extends ProviderSchema> {
  id: string;
  moduleId: string;
  label: string;
  description: string;
  emoji?: string;

  configSchema: C;

  builder: FieldDescriptor[];

  cost: ProviderCost;
}

export interface ConditionProvider<C extends ProviderSchema = ProviderSchema>
  extends ProviderBase<C> {
  kind: 'condition';

  evaluate(ctx: MemberContext, config: z.infer<C>): Promise<ConditionResult>;

  batchEvaluate?(
    ctxs: readonly MemberContext[],
    config: z.infer<C>,
  ): Promise<Map<string, ConditionResult>>;

  describe(config: z.infer<C>, locale: string): string;
  describeFailure(config: z.infer<C>, result: ConditionResult, locale: string): string;
}

export interface MultiplierProvider<C extends ProviderSchema = ProviderSchema>
  extends ProviderBase<C> {
  kind: 'multiplier';

  evaluate(ctx: MemberContext, config: z.infer<C>): Promise<number>;

  batchEvaluate?(ctxs: readonly MemberContext[], config: z.infer<C>): Promise<Map<string, number>>;

  describe(config: z.infer<C>, locale: string): string;
}

export type Provider = ConditionProvider | MultiplierProvider;

export type ProviderKind = Provider['kind'];

export interface ModuleAvailability {
  isEnabled(guildId: string, moduleId: string): Promise<boolean>;
}

export const DEFAULT_LOCALE = 'en';

export function isConditionProvider(provider: Provider): provider is ConditionProvider {
  return provider.kind === 'condition';
}

export function isMultiplierProvider(provider: Provider): provider is MultiplierProvider {
  return provider.kind === 'multiplier';
}
