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

export const moderationConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  requireReason: z.boolean().default(false).register(protonFields, {
    label: 'Require a reason',
  }),

  publicReplies: z.boolean().default(false).register(protonFields, {
    label: 'Reply publicly',
  }),

  defaultTimeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Default timeout duration',
    description:
      'Used when /timeout add is run without a duration. Discord caps timeouts at 28 days.',
  }),

  defaultBanDeleteDays: z
    .number()
    .int()
    .min(0)
    .max(7)
    .default(0)
    .register(protonFields, {
      label: 'Delete messages on ban',
      description:
        'How many days of messages /ban add deletes when no number is given. Discord allows ' +
        'at most 7 days.',
    }),

  escalationWindow: durationStringSchema.default('30d').register(protonFields, {
    field: 'duration',
    label: 'Escalation window',
    description: 'How far back Proton counts a member’s warnings.',
  }),

  escalationLadder: escalationLadderSchema.default([
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ]),
});

export type ModerationConfig = z.infer<typeof moderationConfigSchema>;

export const moderationFormSchema = moderationConfigSchema.omit({ escalationLadder: true });

// A page loaded before moderation owned the ladder posts neither key, and parsing that alone resets it.
export function liftStoredConfig(raw: unknown, current?: Record<string, unknown>): unknown {
  if (current === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }

  if ('escalationWindow' in raw || 'escalationLadder' in raw) return raw;

  return {
    ...raw,
    escalationWindow: current.escalationWindow,
    escalationLadder: current.escalationLadder,
  };
}

export const moderationDefaultConfig: ModerationConfig = {
  enabled: true,
  requireReason: false,
  publicReplies: false,
  defaultTimeoutDuration: '1h',
  defaultBanDeleteDays: 0,
  escalationWindow: '30d',
  escalationLadder: [
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ],
};

export const MODERATION_SCHEMA_VERSION = 2;
