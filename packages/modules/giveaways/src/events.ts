import { type EventType, type ModuleContext, newId } from '@proton/core';
import type { GiveawaysConfig } from './config.ts';
import type { DrawSummary } from './end.ts';
import type { Giveaway, GiveawayEventKind, GiveawayStore } from './store.ts';

export const GIVEAWAY_EMITS: EventType[] = [
  'giveaways.created',
  'giveaways.started',
  'giveaways.edited',
  'giveaways.paused',
  'giveaways.resumed',
  'giveaways.cancelled',
  'giveaways.ended',
  'giveaways.rerolled',
  'giveaways.bonus_granted',
];

type Ctx = ModuleContext<GiveawaysConfig>;

function subject(giveaway: Giveaway) {
  return {
    guildId: giveaway.guildId,
    giveawayId: giveaway.id,
    shortCode: giveaway.shortCode,
    title: giveaway.title,
    channelId: giveaway.channelId,
    hostId: giveaway.hostId,
  };
}

interface Recorded {
  type: EventType;
  kind: GiveawayEventKind;
  actorId: string;
  key: string;
  payload: Record<string, unknown>;
}

/**
 * One call per lifecycle transition writes both halves: a durable line on the giveaway's own
 * timeline, and a bus event for serverlog. Both are best-effort and neither blocks the transition —
 * a serverlog outage must not stop a giveaway being drawn, and `giveaway_draws` holds the
 * reproducible audit row regardless.
 *
 * The shared idempotency key is what makes a redelivered transition a no-op in both.
 */
async function record(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  entry: Recorded,
): Promise<void> {
  await store
    ?.appendEvent({
      id: newId(),
      guildId: giveaway.guildId,
      giveawayId: giveaway.id,
      kind: entry.kind,
      actorId: entry.actorId,
      detail: entry.payload,
      idempotencyKey: entry.key,
    })
    .catch(() => undefined);

  await ctx.publish?.(entry.type, entry.key, entry.payload).catch(() => undefined);
}

export async function publishCreated(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  counts: { requirements: number; multipliers: number },
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.created',
    kind: 'created',
    actorId: giveaway.createdBy,
    key: `giveaways:${giveaway.id}:created`,
    payload: {
      ...subject(giveaway),
      createdById: giveaway.createdBy,
      winnerCount: giveaway.winnerCount,
      endsAt: giveaway.endsAt.getTime(),
      startsAt: giveaway.startsAt?.getTime() ?? null,
      requirementCount: counts.requirements,
      multiplierCount: counts.multipliers,
    },
  });
}

export async function publishStarted(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.started',
    kind: 'started',
    actorId: 'proton:schedule',
    key: `giveaways:${giveaway.id}:started`,
    payload: { ...subject(giveaway), endsAt: giveaway.endsAt.getTime() },
  });
}

export async function publishEdited(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  input: {
    actorId: string;
    changed: readonly string[];
    endsAtBefore: Date | null;
    kind?: GiveawayEventKind;
  },
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.edited',
    kind: input.kind ?? 'edited',
    actorId: input.actorId,
    // The timestamp alone is not enough: two edits can land in the same millisecond, and keying
    // only on it silently collapses them into one history line. What changed is what makes an
    // edit distinct — a genuine redelivery still matches on all three parts.
    key:
      `giveaways:${giveaway.id}:edited:${giveaway.updatedAt.getTime()}:` +
      `${[...input.changed].sort().join(',')}:${giveaway.endsAt.getTime()}`,
    payload: {
      ...subject(giveaway),
      actorId: input.actorId,
      changed: [...input.changed],
      endsAtBefore: input.endsAtBefore?.getTime() ?? null,
      endsAtAfter: giveaway.endsAt.getTime(),
    },
  });
}

export async function publishPaused(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  actorId: string,
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.paused',
    kind: 'paused',
    actorId,
    key: `giveaways:${giveaway.id}:paused:${giveaway.pausedAt?.getTime() ?? 0}`,
    payload: { ...subject(giveaway), actorId, reason: giveaway.pauseReason },
  });
}

export async function publishResumed(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  input: { actorId: string; heldMs: number },
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.resumed',
    kind: 'resumed',
    actorId: input.actorId,
    key: `giveaways:${giveaway.id}:resumed:${giveaway.updatedAt.getTime()}`,
    payload: {
      ...subject(giveaway),
      actorId: input.actorId,
      endsAt: giveaway.endsAt.getTime(),
      heldMs: Math.max(0, input.heldMs),
    },
  });
}

export async function publishCancelled(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  input: { actorId: string; entrantCount: number },
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.cancelled',
    kind: 'cancelled',
    actorId: input.actorId,
    key: `giveaways:${giveaway.id}:cancelled`,
    payload: { ...subject(giveaway), actorId: input.actorId, entrantCount: input.entrantCount },
  });
}

export async function publishDrawn(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  summary: DrawSummary,
  options: { reroll?: boolean; replacedIds?: readonly string[] } = {},
): Promise<void> {
  const payload = {
    ...subject(giveaway),
    drawNumber: summary.drawNumber,
    drawnById: summary.drawnBy,
    winnerIds: [...summary.winnerIds],
    entrantCount: summary.entrantCount,
    totalEntries: summary.totalEntries,
    disqualified: summary.disqualified,
    degradedProviders: [...summary.degraded],
    seed: summary.seed,
    snapshotHash: summary.snapshotHash,
  };

  // Keyed on the draw number, which is unique per giveaway — a redelivered end and a manual one
  // compute the same key and are recorded once.
  await record(ctx, store, giveaway, {
    type: options.reroll ? 'giveaways.rerolled' : 'giveaways.ended',
    kind: options.reroll ? 'rerolled' : 'drawn',
    actorId: summary.drawnBy,
    key: `giveaways:${giveaway.id}:draw:${summary.drawNumber}`,
    payload: options.reroll
      ? { ...payload, replacedIds: [...(options.replacedIds ?? [])] }
      : payload,
  });
}

export async function publishBonus(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  input: {
    actorId: string;
    subjectId: string;
    amount: number;
    reason: string | null;
    revoked: boolean;
  },
): Promise<void> {
  await record(ctx, store, giveaway, {
    type: 'giveaways.bonus_granted',
    kind: input.revoked ? 'bonus-revoked' : 'bonus-granted',
    actorId: input.actorId,
    key:
      `giveaways:${giveaway.id}:bonus:${input.subjectId}:` +
      `${input.revoked ? 'revoked' : 'granted'}:${input.amount}`,
    payload: { ...subject(giveaway), ...input },
  });
}

export async function publishOrphaned(
  ctx: Ctx,
  store: GiveawayStore | undefined,
  giveaway: Giveaway,
  reason: 'message-deleted' | 'channel-deleted',
): Promise<void> {
  // History only — there is no serverlog event for this, and inventing one would mean a catalogue
  // key nothing emits.
  await store
    ?.appendEvent({
      id: newId(),
      guildId: giveaway.guildId,
      giveawayId: giveaway.id,
      kind: 'orphaned',
      actorId: 'proton:cleanup',
      detail: { reason },
      idempotencyKey: `giveaways:${giveaway.id}:orphaned:${reason}`,
    })
    .catch(() => undefined);

  void ctx;
}
