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
  | { outcome: 'entered'; totalEntries: number; breakdown: string[]; degraded: DegradedProvider[] }
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
}

export interface JoinDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
  bucket?: EntryBucket;
}

function describeBreakdown(
  base: number,
  breakdown: readonly { label: string; amount: number; mode: string }[],
): string[] {
  const lines = [`${base} base`];

  for (const entry of breakdown) {
    const sign = entry.mode === 'multiply' ? '×' : '+';
    lines.push(`${sign}${entry.amount} ${entry.label}`);
  }

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

  if (isBlacklisted(input.blacklist, ctx.userId, ctx.member?.roleIds ?? null)) {
    return { outcome: 'blacklisted' };
  }

  const existing = await deps.store.entry(giveaway.id, ctx.userId);
  if (existing) return { outcome: 'already-entered', totalEntries: existing.totalEntries };

  const verdict = await evaluateRequirement(
    deps.providers,
    ctx,
    input.requirements,
    giveaway.requirementLogic,
  );

  if (!verdict.passed) {
    return {
      outcome: 'rejected',
      failures: verdict.failures.map((failure) => failure.humanReason),
    };
  }

  const weight = await evaluateWeight(deps.providers, ctx, input.multipliers, {
    maxEntriesPerUser: giveaway.maxEntriesPerUser,
  });

  const entered = await deps.store.enter({
    giveawayId: giveaway.id,
    userId: ctx.userId,
    baseEntries: weight.base,
    totalEntries: weight.total,
    breakdown: weight.breakdown,
    memberSnapshot: snapshotOf(ctx),
  });

  if (entered === 'already-entered') {
    return { outcome: 'already-entered', totalEntries: weight.total };
  }

  return {
    outcome: 'entered',
    totalEntries: weight.total,
    breakdown: describeBreakdown(weight.base, weight.breakdown),
    degraded: [...verdict.degraded, ...weight.degraded],
  };
}

export function describeJoin(outcome: JoinOutcome, title: string): string {
  switch (outcome.outcome) {
    case 'entered': {
      const sum = outcome.breakdown.join(' ');
      return outcome.totalEntries === 1
        ? `You are in the draw for **${title}**. Good luck.`
        : `You are in the draw for **${title}** with **${outcome.totalEntries} entries** — ${sum}.`;
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
