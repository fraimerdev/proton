import { type ActionKind, formatDuration, MAX_TIMEOUT_MS, tryParseDuration } from '@proton/core';
import type { HoneypotChannel } from './config.ts';

export interface TrapStep {
  kind: ActionKind;
  payload: Record<string, unknown>;

  // Suffixed onto the shared idempotency root. Distinct per step so the ban and the unban are
  // claimed and released independently — a failed unban must stay retryable after a claimed ban.
  suffix: string;
}

export interface TrapPlan {
  steps: TrapStep[];

  // Whether the ban leg has to be lifted again. Read by the caller to decide how loudly a failure
  // after the ban is reported, because that failure leaves a member banned.
  softban: boolean;

  deletesMessages: boolean;
  describe: string;
}

export type TrapPlanResult = { plan: TrapPlan } | { unconfigured: string };

export function planTrap(channel: HoneypotChannel, userId: string, now: number): TrapPlanResult {
  const { action, deleteMessageSeconds } = channel;

  switch (action) {
    case 'softban':
      return {
        plan: {
          softban: true,
          deletesMessages: deleteMessageSeconds > 0,
          describe: 'Softban',
          steps: [
            { kind: 'ban', payload: { userId, deleteMessageSeconds }, suffix: 'ban' },
            { kind: 'unban', payload: { userId }, suffix: 'unban' },
          ],
        },
      };

    case 'ban':
      return {
        plan: {
          softban: false,
          deletesMessages: deleteMessageSeconds > 0,
          describe: 'Ban',
          steps: [{ kind: 'ban', payload: { userId, deleteMessageSeconds }, suffix: 'ban' }],
        },
      };

    case 'kick':
      return {
        plan: {
          softban: false,
          deletesMessages: false,
          describe: 'Kick',
          steps: [{ kind: 'kick', payload: { userId }, suffix: 'kick' }],
        },
      };

    case 'timeout': {
      const ms = tryParseDuration(channel.timeoutDuration);
      if (ms === null || ms <= 0) {
        return {
          unconfigured:
            `This honeypot's timeout length is stored as '${channel.timeoutDuration}', which is ` +
            'not a readable length. It must be a number followed by s, m, h, d or w. Fix it in ' +
            'the Proton dashboard under Honeypot.',
        };
      }

      const capped = Math.min(ms, MAX_TIMEOUT_MS);

      return {
        plan: {
          softban: false,
          deletesMessages: false,
          describe: `Timeout for ${formatDuration(capped)}`,
          steps: [
            {
              kind: 'timeout',
              payload: { userId, until: new Date(now + capped) },
              suffix: 'timeout',
            },
          ],
        },
      };
    }

    case 'warn':
      return {
        plan: {
          softban: false,
          deletesMessages: false,
          describe: 'Warning',
          steps: [
            {
              kind: 'warn',
              payload: { userId, note: 'Posted in a honeypot channel.' },
              suffix: 'warn',
            },
          ],
        },
      };

    case 'none':
      return {
        plan: { softban: false, deletesMessages: false, describe: 'Logged only', steps: [] },
      };
  }
}
