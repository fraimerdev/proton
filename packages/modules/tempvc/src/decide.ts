import { hubFor, type OwnerlessMode, type TempVcConfig, type TempVcHub } from './config.ts';

export interface VoiceTransition {
  userId: string;

  from: string | null;
  to: string | null;
}

/** The temporary channel a member just left, as the database knows it. */
export interface TempSide {
  id: string;
  ownerId: string | null;
  hubChannelId: string;
}

export interface TransitionFacts {
  transition: VoiceTransition;

  fromTemp: TempSide | null;
  fromOccupantsAfter: number;

  /** Who is still inside, oldest arrival first, for the ownerless hand-over. */
  fromOccupants: readonly string[];

  toTemp: TempSide | null;

  /** A live channel this member already owns, so a second hub join sends them to it. */
  ownedChannelId: string | null;
}

export type TempVcStep =
  | { kind: 'create'; hub: TempVcHub }
  | { kind: 'move'; channelId: string }
  | { kind: 'schedule-delete'; rowId: string }
  | { kind: 'cancel-delete'; rowId: string }
  | { kind: 'ownerless'; rowId: string; mode: OwnerlessMode; heir: string | null }
  | { kind: 'grant-role'; rowId: string; hubChannelId: string; isOwner: boolean }
  | { kind: 'revoke-roles'; rowId: string };

export interface TempVcPlan {
  steps: TempVcStep[];
  reason: string;
}

const NOTHING: TempVcPlan = { steps: [], reason: 'nothing about this transition needs a channel' };

/**
 * What a single voice transition means. Pure: every Discord call and every database write is the
 * caller's job, so the decision itself can be tested exhaustively without either.
 */
export function planTransition(config: TempVcConfig, facts: TransitionFacts): TempVcPlan {
  const { transition } = facts;

  if (transition.from === transition.to) {
    return { steps: [], reason: 'the member did not change channel' };
  }

  const steps: TempVcStep[] = [];

  // Leaving comes first. A member who leaves their own channel to open another must not leave the
  // old one behind, and doing it the other way round would schedule a delete on the channel they
  // were just moved into when the two happen to be the same.
  if (facts.fromTemp !== null) {
    steps.push({ kind: 'revoke-roles', rowId: facts.fromTemp.id });

    if (facts.fromOccupantsAfter === 0) {
      steps.push({ kind: 'schedule-delete', rowId: facts.fromTemp.id });
    } else if (facts.fromTemp.ownerId === transition.userId) {
      // The owner walked out of a channel other people are still using.
      const hub = config.hubs.find((entry) => entry.channelId === facts.fromTemp?.hubChannelId);
      const mode: OwnerlessMode = hub?.ownerlessMode ?? 'claim';

      steps.push({
        kind: 'ownerless',
        rowId: facts.fromTemp.id,
        mode,
        heir: mode === 'transfer' ? (facts.fromOccupants[0] ?? null) : null,
      });
    }
  }

  if (facts.toTemp !== null) {
    // Somebody walked back in before the deadline. This is the whole reason deletion is deferred.
    steps.push({ kind: 'cancel-delete', rowId: facts.toTemp.id });
    steps.push({
      kind: 'grant-role',
      rowId: facts.toTemp.id,
      hubChannelId: facts.toTemp.hubChannelId,
      isOwner: facts.toTemp.ownerId === transition.userId,
    });
  }

  const hub = hubFor(config, transition.to);
  if (hub === undefined) {
    return steps.length > 0 ? { steps, reason: 'the member moved between channels' } : NOTHING;
  }

  const owned = facts.ownedChannelId;
  const stillOwned =
    owned !== null &&
    !steps.some(
      (step) =>
        step.kind === 'schedule-delete' &&
        step.rowId === facts.fromTemp?.id &&
        owned === transition.from,
    );

  if (stillOwned) {
    steps.push({ kind: 'move', channelId: owned });
    return { steps, reason: 'the member already has a temporary channel, so they were sent to it' };
  }

  steps.push({ kind: 'create', hub });
  return { steps, reason: 'the member joined a creator channel' };
}

export interface ReconcileRow {
  id: string;
  channelId: string | null;
  status: string;
}

export interface ReconcileFacts {
  known: readonly ReconcileRow[];

  occupantsByChannel: ReadonlyMap<string, readonly string[]>;

  /** Null when the payload did not carry a channel list, in which case nothing is assumed gone. */
  liveChannelIds: ReadonlySet<string> | null;

  /** Rows reserved this long ago never got a channel and never will. */
  staleBefore: Date;

  rowCreatedAt(row: ReconcileRow): Date;
}

export interface ReconcilePlan {
  /** Empty and confirmed present: delete the Discord channel and the row. */
  delete: string[];

  /** The channel is already gone, or the reservation never became one: drop the row only. */
  forget: string[];

  /** Occupied: keep, and clear any deadline left over from before the restart. */
  keep: string[];

  occupants: Array<{ rowId: string; channelId: string; userIds: readonly string[] }>;
}

/**
 * What a restart or a reconnect has to put right. Called both from `guild.available` and from the
 * periodic sweep, because the gateway only re-sends a guild's voice states on a fresh IDENTIFY and
 * a worker restart alone would otherwise never reconcile anything.
 */
export function planReconcile(facts: ReconcileFacts): ReconcilePlan {
  const plan: ReconcilePlan = { delete: [], forget: [], keep: [], occupants: [] };

  for (const row of facts.known) {
    // A reservation with no channel is either in flight right now or died mid-create. Age is what
    // tells them apart, and forgetting it frees the owner's slot.
    if (row.channelId === null) {
      if (facts.rowCreatedAt(row) < facts.staleBefore) plan.forget.push(row.id);
      continue;
    }

    // A channel Discord no longer lists is already gone — deleting it again would spend a
    // rate-limit token to be told 404.
    if (facts.liveChannelIds !== null && !facts.liveChannelIds.has(row.channelId)) {
      plan.forget.push(row.id);
      continue;
    }

    const occupants = facts.occupantsByChannel.get(row.channelId) ?? [];
    plan.occupants.push({ rowId: row.id, channelId: row.channelId, userIds: occupants });

    if (occupants.length === 0) plan.delete.push(row.id);
    else plan.keep.push(row.id);
  }

  return plan;
}
