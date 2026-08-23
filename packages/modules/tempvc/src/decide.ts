import { hubFor, type TempVcConfig, type TempVcHub } from './config.ts';

export interface VoiceTransition {
  userId: string;

  from: string | null;
  to: string | null;
}

export interface TransitionFacts {
  transition: VoiceTransition;

  fromIsTemp: boolean;
  fromOccupantsAfter: number;

  ownedChannelId: string | null;
}

export type TempVcStep =
  | { kind: 'delete'; channelId: string }
  | { kind: 'create'; hub: TempVcHub }
  | { kind: 'move'; channelId: string };

export interface TempVcPlan {
  steps: TempVcStep[];

  reason: string;
}

const NOTHING: TempVcPlan = { steps: [], reason: 'nothing about this transition needs a channel' };

export function planTransition(config: TempVcConfig, facts: TransitionFacts): TempVcPlan {
  const { transition } = facts;

  if (transition.from === transition.to) {
    return { steps: [], reason: 'the member did not change channel' };
  }

  const steps: TempVcStep[] = [];

  // Emptied first, then the new channel: a member leaving their own temp channel to open another
  // must not leave the old one behind, and doing it in the other order would delete the channel
  // they were just moved into when the two happen to be the same.
  if (transition.from !== null && facts.fromIsTemp && facts.fromOccupantsAfter === 0) {
    steps.push({ kind: 'delete', channelId: transition.from });
  }

  const hub = hubFor(config, transition.to);
  if (hub === undefined) {
    return steps.length > 0
      ? { steps, reason: 'the member left a temporary channel that is now empty' }
      : NOTHING;
  }

  const owned = facts.ownedChannelId;
  const stillOwned =
    owned !== null && !steps.some((step) => step.kind === 'delete' && step.channelId === owned);

  if (stillOwned) {
    steps.push({ kind: 'move', channelId: owned });
    return { steps, reason: 'the member already has a temporary channel, so they were sent to it' };
  }

  steps.push({ kind: 'create', hub });
  return { steps, reason: 'the member joined a hub' };
}

export interface ReconcileFacts {
  known: readonly string[];

  occupantsByChannel: ReadonlyMap<string, readonly string[]>;

  liveChannelIds: ReadonlySet<string> | null;
}

export interface ReconcilePlan {
  delete: string[];

  forget: string[];
  reset: Array<{ channelId: string; userIds: readonly string[] }>;

  // Occupancy alone is not enough to recover: the next VOICE_STATE_UPDATE says only where the
  // member is now, so without re-learning where each one is sitting the first person to leave
  // after a restart looks like they came from nowhere and their channel is never emptied.
  place: Array<{ userId: string; channelId: string }>;
}

export function planReconcile(facts: ReconcileFacts): ReconcilePlan {
  const plan: ReconcilePlan = { delete: [], forget: [], reset: [], place: [] };

  for (const channelId of facts.known) {
    // A channel Discord no longer lists is already gone — deleting it again would spend a
    // rate-limit token to be told 404.
    if (facts.liveChannelIds !== null && !facts.liveChannelIds.has(channelId)) {
      plan.forget.push(channelId);
      continue;
    }

    const occupants = facts.occupantsByChannel.get(channelId) ?? [];
    plan.reset.push({ channelId, userIds: occupants });

    for (const userId of occupants) plan.place.push({ userId, channelId });

    if (occupants.length === 0) plan.delete.push(channelId);
  }

  return plan;
}
