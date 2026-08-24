import { type ActionKind, formatDuration, MAX_TIMEOUT_MS, tryParseDuration } from '@proton/core';
import type { VerificationConfig } from './config.ts';

export interface FailurePlan {
  kind: ActionKind;
  payload: Record<string, unknown>;

  told: string;
  logged: string;
}

export type FailurePlanResult = { plan: FailurePlan } | { unconfigured: string };

export function planFailure(
  config: VerificationConfig,
  userId: string,
  now: number,
): FailurePlanResult | null {
  const action = config.failureAction;
  if (action === 'none') return null;

  switch (action) {
    case 'kick':
      return {
        plan: {
          kind: 'kick',
          payload: { userId },
          told: 'You have been removed from the server. You can rejoin and try again.',
          logged: 'kicked',
        },
      };

    case 'ban':
      return {
        plan: {
          kind: 'ban',
          payload: { userId, deleteMessageSeconds: 0 },
          told: 'You have been banned from the server.',
          logged: 'banned',
        },
      };

    case 'timeout': {
      const ms = tryParseDuration(config.failureTimeout);
      if (ms === null || ms <= 0) {
        return {
          unconfigured:
            `Verification's Timeout length is stored as '${config.failureTimeout}', which is not a ` +
            'readable length. It must be a number followed by s, m, h, d or w. Fix it in the ' +
            'Proton dashboard under Verification.',
        };
      }

      const capped = Math.min(ms, MAX_TIMEOUT_MS);

      return {
        plan: {
          kind: 'timeout',
          payload: { userId, until: new Date(now + capped) },
          told: `You have been timed out for ${formatDuration(capped)}.`,
          logged: `timed out for ${formatDuration(capped)}`,
        },
      };
    }

    case 'quarantine': {
      const roleId = config.quarantineRoleId;
      if (!roleId) {
        return {
          unconfigured:
            'Verification is set to quarantine members who run out of attempts, but no quarantine ' +
            'role is chosen, so Proton cannot act on them. Set one in the Proton dashboard under ' +
            'Verification → Quarantine role.',
        };
      }

      return {
        plan: {
          kind: 'add_role',
          payload: { userId, roleId },
          told: 'Your access has been restricted. Contact a moderator if this was a mistake.',
          logged: 'quarantined',
        },
      };
    }
  }
}
