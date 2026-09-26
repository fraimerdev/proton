import {
  absentMemberContext,
  evaluateMultipliers,
  type MemberContext,
  type MemberContextLoader,
  type MultiplierSpec,
  type ProviderRegistry,
  type RequirementSpec,
} from '@proton/core';
import { MODULE_ID } from './config.ts';
import { sampleWeightedAsync, type WeightedEntrant } from './draw.ts';
import { newSeed, rngFromSeed } from './rng.ts';
import { evaluateRules, requirementTreeOf } from './rules.ts';
import { StreamingSnapshotHash } from './snapshot.ts';
import type {
  Disqualification,
  EntrantRow,
  Giveaway,
  GiveawayStatus,
  GiveawayStore,
  MemberSnapshot,
  Reweigh,
} from './store.ts';

export const DRAW_CHUNK_SIZE = 500;

export function drawKey(guildId: string, giveawayId: string, drawNumber: number): string {
  return `${MODULE_ID}:${guildId}:${giveawayId}:draw:${drawNumber}`;
}

export interface DrawSummary {
  drawId: string;
  drawNumber: number;
  drawnBy: string;
  seed: string;
  snapshotHash: string;
  entrantCount: number;
  totalEntries: number;
  winnerIds: string[];
  disqualified: number;
  degraded: string[];
  unchecked: number;
}

export type DrawOutcome =
  | { outcome: 'drawn'; giveaway: Giveaway; summary: DrawSummary }
  | { outcome: 'already-drawing'; giveaway: Giveaway }
  | { outcome: 'already-ended'; giveaway: Giveaway }
  | { outcome: 'missing' };

export interface DrawDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
  members?: MemberContextLoader;
  now?: () => number;
  seed?: () => string;
  chunkSize?: number;
}

export interface DrawInput {
  guildId: string;
  giveawayId: string;
  drawnBy: string;
  reason?: string;
  /** Prior winners a reroll must not pick again. */
  exclude?: readonly string[];
  winnerCount?: number;
}

function contextFromSnapshot(
  guildId: string,
  userId: string,
  snapshot: MemberSnapshot,
  now: Date,
): MemberContext | null {
  const base = absentMemberContext(guildId, userId, now);
  if (!base) return null;

  return {
    ...base,
    member: {
      roleIds: snapshot.roleIds,
      joinedAt: snapshot.joinedAt ? new Date(snapshot.joinedAt) : null,
      premiumSince: snapshot.premiumSince ? new Date(snapshot.premiumSince) : null,
      communicationDisabledUntil: null,
    },
    user: { ...base.user, hasAvatar: snapshot.hasAvatar },
    // Snapshot facts are as old as the join, so a provider that cannot judge from them says so
    // rather than pretending the member still looks the way they did when they entered.
    partial: true,
  };
}

interface EntrantContexts {
  contexts: Map<string, MemberContext>;
  fromSnapshot: Set<string>;
  unchecked: number;
}

async function contextsFor(
  deps: DrawDeps,
  guildId: string,
  rows: readonly EntrantRow[],
  now: Date,
): Promise<EntrantContexts> {
  const loaded = deps.members
    ? await deps.members.load(
        guildId,
        rows.map((row) => row.userId),
      )
    : new Map<string, MemberContext>();

  const contexts = new Map<string, MemberContext>();
  const fromSnapshot = new Set<string>();
  let unchecked = 0;

  for (const row of rows) {
    const live = loaded.get(row.userId);
    if (live) {
      contexts.set(row.userId, live);
      continue;
    }

    unchecked += 1;

    // No answer and no snapshot leaves them unjudged: an absent context would read as having left.
    if (row.memberSnapshot === null) continue;

    const ctx = contextFromSnapshot(guildId, row.userId, row.memberSnapshot, now);
    if (!ctx) continue;

    contexts.set(row.userId, ctx);
    fromSnapshot.add(row.userId);
  }

  return { contexts, fromSnapshot, unchecked };
}

interface RevalidationResult {
  disqualified: number;
  degraded: Set<string>;
  unchecked: number;
}

async function revalidate(
  deps: DrawDeps,
  giveaway: Giveaway,
  requirements: readonly RequirementSpec[],
  multipliers: readonly MultiplierSpec[],
  now: Date,
): Promise<RevalidationResult> {
  const chunkSize = deps.chunkSize ?? DRAW_CHUNK_SIZE;
  const degraded = new Set<string>();
  let disqualified = 0;
  let unchecked = 0;

  for await (const rows of deps.store.entrants(giveaway.id, chunkSize)) {
    const entrants = await contextsFor(deps, giveaway.guildId, rows, now);
    const { contexts, fromSnapshot } = entrants;
    unchecked += entrants.unchecked;

    const ctxs = rows
      .map((row) => contexts.get(row.userId))
      .filter((ctx): ctx is MemberContext => ctx !== undefined);

    if (ctxs.length === 0) continue;

    // One batchEvaluate per distinct requirement for the whole chunk, never one per entrant —
    // the tree is flattened to distinct leaves before anything is evaluated.
    const verdicts = await evaluateRules(
      deps.providers,
      ctxs,
      requirementTreeOf(giveaway, requirements),
      { chunkSize },
    );

    const drops: Disqualification[] = [];
    const survivors: MemberContext[] = [];

    for (const ctx of ctxs) {
      const verdict = verdicts.get(ctx.userId);
      for (const entry of verdict?.degraded ?? []) degraded.add(entry.providerId);

      if (ctx.member === null) {
        drops.push({ userId: ctx.userId, reason: 'left the server before the draw' });
        continue;
      }

      // Indeterminate on a join snapshot is a fact it never recorded, not a failed requirement.
      const unanswerable = verdict?.indeterminate === true && fromSnapshot.has(ctx.userId);

      if (verdict && !verdict.passed && !unanswerable) {
        const reason = verdict.failures[0]?.humanReason ?? 'no longer meets the requirements';
        drops.push({ userId: ctx.userId, reason });
        continue;
      }

      survivors.push(ctx);
    }

    if (drops.length > 0) {
      disqualified += await deps.store.disqualify(giveaway.id, drops, now);
    }

    if (survivors.length > 0 && multipliers.length > 0) {
      const weights = await evaluateMultipliers(deps.providers, survivors, multipliers, {
        maxEntriesPerUser: giveaway.maxEntriesPerUser,
        chunkSize,
      });

      const reweighs: Reweigh[] = [];
      for (const ctx of survivors) {
        const weight = weights.get(ctx.userId);
        if (!weight) continue;

        for (const entry of weight.degraded) degraded.add(entry.providerId);
        reweighs.push({
          userId: ctx.userId,
          totalEntries: weight.total,
          breakdown: weight.breakdown,
        });
      }

      await deps.store.reweigh(giveaway.id, reweighs, now);
    }
  }

  return { disqualified, degraded, unchecked };
}

async function* weighted(
  deps: DrawDeps,
  giveawayId: string,
  chunkSize: number,
  exclude: ReadonlySet<string>,
): AsyncIterable<WeightedEntrant[]> {
  for await (const rows of deps.store.entrants(giveawayId, chunkSize)) {
    yield rows
      .filter((row) => !exclude.has(row.userId))
      .map((row) => ({ userId: row.userId, weight: row.totalEntries }));
  }
}

/**
 * Exactly-once by construction:
 *  1. `beginDraw` is a conditional update — exactly one caller moves `running -> drawing`.
 *  2. `UNIQUE (giveaway_id, draw_number)` refuses a second result for the same draw number.
 *  3. The caller's ActionExecutor key is derived from (guild, giveaway, draw number), so a manual
 *     end and a firing job compute the same key and announce once.
 */
export async function drawGiveaway(deps: DrawDeps, input: DrawInput): Promise<DrawOutcome> {
  const now = new Date(deps.now?.() ?? Date.now());

  const existing = await deps.store.get(input.guildId, input.giveawayId);
  if (!existing) return { outcome: 'missing' };
  if (existing.status === 'drawing') return { outcome: 'already-drawing', giveaway: existing };

  const giveaway = await deps.store.beginDraw(input.guildId, input.giveawayId, now);
  if (!giveaway) {
    const current = await deps.store.get(input.guildId, input.giveawayId);
    if (!current) return { outcome: 'missing' };

    return current.status === 'drawing'
      ? { outcome: 'already-drawing', giveaway: current }
      : { outcome: 'already-ended', giveaway: current };
  }

  const [requirementRows, multiplierRows] = await Promise.all([
    deps.store.requirements(giveaway.id),
    deps.store.multipliers(giveaway.id),
  ]);

  const requirements: RequirementSpec[] = requirementRows.map((row) => ({
    providerId: row.providerId,
    config: row.config,
  }));
  const multipliers: MultiplierSpec[] = multiplierRows.map((row) => ({
    providerId: row.providerId,
    config: row.config,
    mode: row.mode,
  }));

  const degraded = new Set<string>();
  let disqualified = 0;
  let unchecked = 0;

  if (giveaway.verifyOn === 'draw' || giveaway.verifyOn === 'both') {
    const result = await revalidate(deps, giveaway, requirements, multipliers, now);
    disqualified = result.disqualified;
    unchecked = result.unchecked;
    for (const providerId of result.degraded) degraded.add(providerId);
  }

  const chunkSize = deps.chunkSize ?? DRAW_CHUNK_SIZE;
  const exclude = new Set(input.exclude ?? []);
  const hash = new StreamingSnapshotHash();
  const seed = deps.seed?.() ?? newSeed();

  // One pass feeds both the digest and the sampler: the snapshot a draw attests to is exactly the
  // stream it drew from, in exactly the order it read it.
  const winnerIds = await sampleWeightedAsync(
    weighted(deps, giveaway.id, chunkSize, exclude),
    input.winnerCount ?? giveaway.winnerCount,
    rngFromSeed(seed),
    (entrant) => hash.offer({ userId: entrant.userId, totalEntries: entrant.weight }),
  );

  const drawNumber = (await deps.store.lastDrawNumber(giveaway.id)) + 1;
  const claimDeadline = giveaway.claimWindowSeconds
    ? new Date(now.getTime() + giveaway.claimWindowSeconds * 1000)
    : null;

  // Once: a node Hash is consumed by digest() and answers the same value only if you keep it.
  const snapshotHash = hash.digest();

  const recorded = await deps.store.recordDraw({
    id: `${giveaway.id}:${drawNumber}`,
    giveawayId: giveaway.id,
    drawNumber,
    seed,
    snapshotHash,
    entrantCount: hash.count,
    totalEntries: hash.totalEntries,
    winnerIds,
    degradedProviders: [...degraded],
    drawnBy: input.drawnBy,
    reason: input.reason ?? null,
    claimDeadline,
  });

  if (recorded === 'already-drawn') {
    await deps.store.finishDraw(input.guildId, giveaway.id, ['drawing'], 'ended', now);
    return { outcome: 'already-ended', giveaway };
  }

  await deps.store.finishDraw(input.guildId, giveaway.id, ['drawing'], 'ended', now);

  return {
    outcome: 'drawn',
    giveaway,
    summary: {
      drawId: recorded.drawId,
      drawNumber,
      drawnBy: input.drawnBy,
      seed,
      snapshotHash,
      entrantCount: hash.count,
      totalEntries: hash.totalEntries,
      winnerIds,
      disqualified,
      degraded: [...degraded],
      unchecked,
    },
  };
}

export const CANCELLABLE: readonly GiveawayStatus[] = ['running', 'scheduled', 'paused'];

export type CancelOutcome =
  | { outcome: 'cancelled'; giveaway: Giveaway }
  | { outcome: 'already-ended'; giveaway: Giveaway }
  | { outcome: 'missing' };

export async function cancelGiveaway(
  deps: DrawDeps,
  guildId: string,
  giveawayId: string,
): Promise<CancelOutcome> {
  const now = new Date(deps.now?.() ?? Date.now());

  const giveaway = await deps.store.get(guildId, giveawayId);
  if (!giveaway) return { outcome: 'missing' };

  // The conditional update is the decision, not the read above it: a draw that began between the
  // two would otherwise be told "nobody was drawn" while it announces winners.
  const cancelled = await deps.store.finishDraw(guildId, giveawayId, CANCELLABLE, 'cancelled', now);

  if (!cancelled) {
    const current = await deps.store.get(guildId, giveawayId);
    return current ? { outcome: 'already-ended', giveaway: current } : { outcome: 'missing' };
  }

  return { outcome: 'cancelled', giveaway };
}
