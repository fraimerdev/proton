import { type ActionKind, reversalOf } from './kinds.ts';
import {
  banPayloadSchema,
  lockdownPayloadSchema,
  roleChangePayloadSchema,
  timeoutPayloadSchema,
} from './payloads.ts';
import type { ActionRequest } from './types.ts';

export const AUTO_REVERSAL_ACTOR = 'proton:auto-reversal';

export function reversalIdempotencyKey(originalKey: string): string {
  return `reversal:${originalKey}`;
}

export interface CaseReversalInput {
  caseId: string;
  revertedAt: Date;
  revertedBy: string;
}

export interface CaseReversalStore {
  markReverted(input: CaseReversalInput): Promise<void>;
}

export interface ReversalPlan {
  kind: ActionKind;

  payload: Record<string, unknown>;
}

export type ReversalPlanResult = { plan: ReversalPlan } | { error: string };

function invalid(request: ActionRequest, detail: string): { error: string } {
  return {
    error: `Can't plan the reversal of this '${request.kind}': ${detail}`,
  };
}

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

            restoreAllow: p.data.previousAllow,
            restoreDeny: p.data.previousDeny,
          },
        },
      };
    }

    default:
      return {
        error: `'${request.kind}' is paired with '${kind}' but no payload translation exists for it.`,
      };
  }
}
