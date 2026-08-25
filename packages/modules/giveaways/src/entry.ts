import {
  type DegradedProvider,
  evaluateRequirement,
  evaluateWeight,
  type MemberContext,
  type MultiplierSpec,
  type ProviderRegistry,
  type RequirementSpec,
} from '@proton/core';
import type { Redis } from 'ioredis';
import type { Giveaway, GiveawayStore, MemberSnapshot } from './store.ts';

export interface EntryBucket {
  /** False when this member is pressing the button faster than anyone legitimately can. */
  allow(giveawayId: string, userId: string): Promise<boolean>;
}

export const ENTRY_BUCKET_PREFIX = 'proton:giveaways:bucket';
export const ENTRY_BUCKET_WINDOW_MS = 3_000;

export class RedisEntryBucket implements EntryBucket {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #windowMs: number;

  constructor(redis: Redis, options: { prefix?: string; windowMs?: number } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? ENTRY_BUCKET_PREFIX;
    this.#windowMs = options.windowMs ?? ENTRY_BUCKET_WINDOW_MS;
  }

  async allow(giveawayId: string, userId: string): Promise<boolean> {
    const won = await this.#redis.set(
      `${this.#prefix}:${giveawayId}:${userId}`,
      '1',
      'PX',
      this.#windowMs,
      'NX',
    );

    return won === 'OK';
  }
}

export class AllowAllBucket implements EntryBucket {
  async allow(): Promise<boolean> {
    return true;
  }
}

export function snapshotOf(ctx: MemberContext): MemberSnapshot | null {
  if (ctx.member === null) return null;

  return {
    roleIds: ctx.member.roleIds,
    joinedAt: ctx.member.joinedAt?.toISOString() ?? null,
    premiumSince: ctx.member.premiumSince?.toISOString() ?? null,
    hasAvatar: ctx.user.hasAvatar,
  };
}

export function hasAny(
  roleIds: readonly string[] | null,
  wanted: readonly string[] | undefined,
): boolean {
  if (!wanted || wanted.length === 0 || roleIds === null) return false;
  return wanted.some((roleId) => roleIds.includes(roleId));
}

export function isBlacklisted(
  blacklist: readonly { subjectType: 'user' | 'role'; subjectId: string }[],
  userId: string,
  roleIds: readonly string[] | null,
): boolean {
  for (const entry of blacklist) {
    if (entry.subjectType === 'user' && entry.subjectId === userId) return true;
    if (entry.subjectType === 'role' && roleIds?.includes(entry.subjectId)) return true;
  }

  return false;
}

export type JoinOutcome =
  | {
      outcome: 'entered';
      totalEntries: number;
      breakdown: string[];
      degraded: DegradedProvider[];
      bypassed?: boolean;
    }
  | { outcome: 'already-entered'; totalEntries: number }
  | { outcome: 'rejected'; failures: string[] }
  | { outcome: 'blacklisted' }
  | { outcome: 'rate-limited' }
  | { outcome: 'closed' };

export interface JoinInput {
  giveaway: Giveaway;
  ctx: MemberContext;
  requirements: readonly RequirementSpec[];
  multipliers: readonly MultiplierSpec[];
  blacklist: readonly { subjectType: 'user' | 'role'; subjectId: string }[];

  /** Guild-wide roles from module config, on top of the per-guild blacklist table. */
  blacklistRoleIds?: readonly string[];

  /** Guild-wide roles that skip every requirement. Multipliers still apply. */
  bypassRoleIds?: readonly string[];
}

export interface JoinDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
  bucket?: EntryBucket;
}

function describeBreakdown(
  base: number,
  breakdown: readonly { label: string; amount: number; mode: string }[],
  bonus = 0,
): string[] {
  const lines = [`${base} base`];

  for (const entry of breakdown) {
    const sign = entry.mode === 'multiply' ? '×' : '+';
    lines.push(`${sign}${entry.amount} ${entry.label}`);
  }

  if (bonus > 0) lines.push(`+${bonus} granted by staff`);

  return lines;
}

export async function join(deps: JoinDeps, input: JoinInput): Promise<JoinOutcome> {
  const { giveaway, ctx } = input;

  if (giveaway.status !== 'running') return { outcome: 'closed' };

  // Before any database work: a member holding the button down should cost one Redis round trip,
  // not a requirement evaluation and an insert.
  if (deps.bucket && !(await deps.bucket.allow(giveaway.id, ctx.userId))) {
    return { outcome: 'rate-limited' };
  }

  const roleIds = ctx.member?.roleIds ?? null;

  const blacklist = [
    ...input.blacklist,
    ...(input.blacklistRoleIds ?? []).map((subjectId) => ({
      subjectType: 'role' as const,
      subjectId,
    })),
  ];

  if (isBlacklisted(blacklist, ctx.userId, roleIds)) return { outcome: 'blacklisted' };

  const existing = await deps.store.entry(giveaway.id, ctx.userId);
  if (existing) return { outcome: 'already-entered', totalEntries: existing.totalEntries };

  // One decision in the authorization layer rather than a flag threaded through every provider:
  // a bypass role skips requirement evaluation entirely. Multipliers still run — bypassing the
  // rules is not the same as forfeiting the bonus entries a member has earned.
  const bypassed = hasAny(roleIds, input.bypassRoleIds);

  const verdict = bypassed
    ? { passed: true, failures: [], degraded: [] }
    : await evaluateRequirement(deps.providers, ctx, input.requirements, giveaway.requirementLogic);

  if (!verdict.passed) {
    return {
      outcome: 'rejected',
      failures: verdict.failures.map((failure) => failure.humanReason),
    };
  }

  const weight = await evaluateWeight(deps.providers, ctx, input.multipliers, {
    maxEntriesPerUser: giveaway.maxEntriesPerUser,
  });

  // A bonus can be granted before its recipient has entered — rewarding event participation up
  // front is the normal case — so it is folded in here rather than only at the draw-time recompute.
  const bonus = await deps.store.bonusFor(giveaway.id, ctx.userId);
  const totalEntries = weight.total + bonus;

  const entered = await deps.store.enter({
    giveawayId: giveaway.id,
    userId: ctx.userId,
    baseEntries: weight.base,
    totalEntries,
    breakdown: weight.breakdown,
    memberSnapshot: snapshotOf(ctx),
  });

  if (entered === 'already-entered') {
    return { outcome: 'already-entered', totalEntries };
  }

  // The insert carries its own status predicate, so it can refuse a giveaway that stopped running
  // between the check at the top of this function and the write. Reporting that as an entry would
  // tell a member they are in a draw they are not in.
  if (entered === 'closed') return { outcome: 'closed' };

  return {
    outcome: 'entered',
    totalEntries,
    breakdown: describeBreakdown(weight.base, weight.breakdown, bonus),
    degraded: [...verdict.degraded, ...weight.degraded],
    ...(bypassed ? { bypassed: true } : {}),
  };
}

export function describeJoin(outcome: JoinOutcome, title: string): string {
  switch (outcome.outcome) {
    case 'entered': {
      const sum = outcome.breakdown.join(' ');
      const bypass = outcome.bypassed ? ' Your role skipped the requirements.' : '';

      return outcome.totalEntries === 1
        ? `You are in the draw for **${title}**. Good luck.${bypass}`
        : `You are in the draw for **${title}** with **${outcome.totalEntries} entries** — ` +
            `${sum}.${bypass}`;
    }

    case 'already-entered':
      return (
        `You are already in the draw for **${title}** with ` +
        `${outcome.totalEntries === 1 ? 'one entry' : `${outcome.totalEntries} entries`}.`
      );

    // Every failed requirement, never a bare "you don't qualify" (GIVEAWAYS.md §6.4).
    case 'rejected':
      return [
        `You are not in the draw for **${title}** yet. Here is what is missing:`,
        ...outcome.failures.map((failure) => `• ${failure}`),
      ].join('\n');

    case 'blacklisted':
      return `You are not eligible for giveaways in this server. Ask a server admin why.`;

    case 'rate-limited':
      return 'You already pressed that. Give it a second and check again.';

    case 'closed':
      return `**${title}** is not accepting entries any more.`;
  }
}
