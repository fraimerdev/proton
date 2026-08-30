import { type ActionKind, formatDuration, MAX_TIMEOUT_MS, tryParseDuration } from '@proton/core';
import { z } from 'zod';
import { DELETE_SECONDS_MAX, HONEYPOT_ACTIONS } from './config.ts';

// Detached from HoneypotConfig on purpose: a delayed punishment is booked now and carried out
// later, and it has to run under the settings it was booked with rather than whatever the guild
// has saved by then.
export const punishmentSchema = z.object({
  action: z.enum(HONEYPOT_ACTIONS),
  deleteMessageSeconds: z.number().int().min(0).max(DELETE_SECONDS_MAX),
  timeoutDuration: z.string(),

  timeoutFirst: z.boolean().default(false),
  timeoutFirstDuration: z.string().default('5m'),

  deleteTriggerMessage: z.boolean().default(true),
});

export type Punishment = z.infer<typeof punishmentSchema>;

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

function timeoutMs(raw: string, what: string): number | { unconfigured: string } {
  const ms = tryParseDuration(raw);
  if (ms === null || ms <= 0) {
    return {
      unconfigured:
        `This honeypot's ${what} is stored as '${raw}', which is not a readable length. It must ` +
        'be a number followed by s, m, h, d or w. Fix it in the Proton dashboard under Honeypot.',
    };
  }

  return Math.min(ms, MAX_TIMEOUT_MS);
}

export function planTrap(punishment: Punishment, userId: string, now: number): TrapPlanResult {
  const { action, deleteMessageSeconds } = punishment;

  const holding: TrapStep[] = [];

  // Collapsed when the punishment is itself a timeout: two timeout calls on one member is the
  // second overwriting the first, and the holding one is always the shorter.
  if (punishment.timeoutFirst && action !== 'timeout' && action !== 'none') {
    const held = timeoutMs(punishment.timeoutFirstDuration, 'holding timeout');
    if (typeof held !== 'number') return held;

    holding.push({
      kind: 'timeout',
      payload: { userId, until: new Date(now + held) },

      // Never 'timeout': the executor would call the punishment's own timeout step a duplicate,
      // and a skipped duplicate reads as success.
      suffix: 'timeout-first',
    });
  }

  switch (action) {
    case 'softban':
      return {
        plan: {
          softban: true,
          deletesMessages: deleteMessageSeconds > 0,
          describe: 'Softban',
          steps: [
            ...holding,
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
          steps: [
            ...holding,
            { kind: 'ban', payload: { userId, deleteMessageSeconds }, suffix: 'ban' },
          ],
        },
      };

    case 'kick':
      return {
        plan: {
          softban: false,
          deletesMessages: false,
          describe: 'Kick',
          steps: [...holding, { kind: 'kick', payload: { userId }, suffix: 'kick' }],
        },
      };

    case 'timeout': {
      const capped = timeoutMs(punishment.timeoutDuration, 'timeout length');
      if (typeof capped !== 'number') return capped;

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
            ...holding,
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
