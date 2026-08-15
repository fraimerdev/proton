import { type ActionKind, reversalOf } from './kinds.ts';
import {
  banPayloadSchema,
  lockdownPayloadSchema,
  roleChangePayloadSchema,
  timeoutPayloadSchema,
} from './payloads.ts';
import type { ActionRequest } from './types.ts';

/**
 * `cases.reverted_by` for an automatic reversal.
 *
 * Deliberately not a snowflake — nobody pressed a button. Attributing the unban
 * to the moderator who imposed the temp ban would read, in the dashboard and in
 * Discord's audit log, as that moderator having lifted it by hand.
 */
export const AUTO_REVERSAL_ACTOR = 'proton:auto-reversal';

/**
 * The reversal's idempotency key, derived from the original action's.
 *
 * Derived rather than random so the whole chain is replay-safe: the gateway can
 * redeliver the ban, the scheduler can run twice, the sweeper can crash between
 * executing and recording — every path lands on this one key, and the UNIQUE
 * constraints on `scheduled_actions.idempotency_key` and `cases.idempotency_key`
 * turn the duplicates into no-ops (I4).
 */
export function reversalIdempotencyKey(originalKey: string): string {
  return `reversal:${originalKey}`;
}

export interface ReversalPlan {
  kind: ActionKind;
  /** JSON-safe: this round-trips through `scheduled_actions.payload` as JSONB. */
  payload: Record<string, unknown>;
}

export type ReversalPlanResult = { plan: ReversalPlan } | { error: string };

function invalid(request: ActionRequest, detail: string): { error: string } {
  return {
    error: `Can't plan the reversal of this '${request.kind}': ${detail}`,
  };
}

/**
 * Work out the action that undoes `request`, and the payload it needs.
 *
 * The pairing lives in `REVERSAL_OF`; this adds the payload translation, which
 * is not always a copy — `unlock` restores the overwrite bits `lockdown`
 * recorded, under different field names (R4). No branch emits a `Date`: the plan
 * is stored as JSONB and read back by a different process, and a `Date` would
 * return as a string that the payload schema then rejects.
 */
export function planReversal(request: ActionRequest): ReversalPlanResult {
  const kind = reversalOf(request.kind);
  if (!kind) {
    return {
      error: `'${request.kind}' can't be temporary — Proton has no action that undoes it.`,
    };
  }

  switch (request.kind) {
    case 'ban': {
      const p = banPayloadSchema.safeParse(request.payload);
      if (!p.success) return invalid(request, 'the ban payload has no user id.');
      return { plan: { kind: 'unban', payload: { userId: p.data.userId } } };
    }

    case 'timeout': {
      const p = timeoutPayloadSchema.safeParse(request.payload);
      if (!p.success) return invalid(request, 'the timeout payload has no user id.');
      // Discord lifts a timeout on its own at `communication_disabled_until`, so
      // this call is usually redundant. It is scheduled anyway because the ledger
      // is not: without it the case would still read as active forever.
      return { plan: { kind: 'untimeout', payload: { userId: p.data.userId } } };
    }

    case 'add_role': {
      const p = roleChangePayloadSchema.safeParse(request.payload);
      if (!p.success) return invalid(request, 'the role payload needs a user id and a role id.');
      return {
        plan: { kind: 'remove_role', payload: { userId: p.data.userId, roleId: p.data.roleId } },
      };
    }

    case 'lockdown': {
      const p = lockdownPayloadSchema.safeParse(request.payload);
      if (!p.success) return invalid(request, 'the lockdown payload needs a channel and a role.');
      return {
        plan: {
          kind: 'unlock',
          payload: {
            channelId: p.data.channelId,
            roleId: p.data.roleId,
            // Exactly what the channel had before the lockdown, not a guess.
            restoreAllow: p.data.previousAllow,
            restoreDeny: p.data.previousDeny,
          },
        },
      };
    }

    // Unreachable while this switch and REVERSAL_OF agree; `reversal.test.ts`
    // walks every REVERSAL_OF key to keep them from drifting apart.
    default:
      return {
        error: `'${request.kind}' is paired with '${kind}' but no payload translation exists for it.`,
      };
  }
}
