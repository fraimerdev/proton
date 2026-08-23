import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

export const ESCALATION_ACTIONS = ['timeout', 'kick', 'ban'] as const;

export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

export const escalationRungSchema = z.object({
  atWarnings: z.number().int().min(2).max(100),
  action: z.enum(ESCALATION_ACTIONS),

  duration: durationStringSchema.optional(),
});

export type EscalationRung = z.infer<typeof escalationRungSchema>;

function strictlyIncreasing(rungs: readonly EscalationRung[]): boolean {
  return rungs.every((rung, i) => i === 0 || rung.atWarnings > (rungs[i - 1]?.atWarnings ?? 0));
}

function timeoutsHaveDuration(rungs: readonly EscalationRung[]): boolean {
  return rungs.every((rung) => rung.action !== 'timeout' || rung.duration !== undefined);
}

export const escalationLadderSchema = z
  .array(escalationRungSchema)
  .max(20)
  .refine(strictlyIncreasing, {
    message:
      'rungs must be ordered by atWarnings, strictly increasing — two rungs at the same ' +
      'warning count would both fire on it.',
  })
  .refine(timeoutsHaveDuration, {
    message:
      "a 'timeout' rung needs a duration, e.g. 1h — Discord timeouts are an expiry, not a flag.",
  });

export const casesConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  historyLimit: z.number().int().min(1).max(25).default(10).register(protonFields, {
    label: 'Cases shown in /history',
  }),

  escalationWindow: durationStringSchema.default('30d').register(protonFields, {
    field: 'duration',
    label: 'Escalation window',
  }),

  escalationLadder: escalationLadderSchema.default([
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ]),
});

export type CasesConfig = z.infer<typeof casesConfigSchema>;

export const casesFormSchema = casesConfigSchema.omit({ escalationLadder: true });

export const casesDefaultConfig: CasesConfig = {
  enabled: true,
  historyLimit: 10,
  escalationWindow: '30d',
  escalationLadder: [
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ],
};

export const CASES_SCHEMA_VERSION = 1;
