import { type ConfigWriteIssue, durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';
import {
  PUNISH_DEFAULTS,
  PUNISH_DIRECTIONS,
  punishConfigSchema,
  refinePunishWrite,
} from './punish/config.ts';
import { REPORTS_DEFAULTS, refineReportsWrite, reportsConfigSchema } from './reports/config.ts';

export * from './punish/config.ts';
export * from './reports/config.ts';

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
      'Each step needs a higher warning count than the one before it. Two steps at the same ' +
      'count would both run.',
  })
  .refine(timeoutsHaveDuration, {
    message: 'A timeout step needs a duration, like 1h.',
  });

export const moderationConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  publicReplies: z.boolean().default(false).register(protonFields, {
    label: 'Reply publicly',
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

  punish: punishConfigSchema.prefault({}),

  reports: reportsConfigSchema.prefault({}),
});

export type ModerationConfig = z.infer<typeof moderationConfigSchema>;

export const moderationFormSchema = moderationConfigSchema.omit({
  escalationLadder: true,
  punish: true,
  reports: true,
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function legacyPunish(
  source: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const read = (key: string) => (Object.hasOwn(source, key) ? source[key] : current?.[key]);

  const requireReason = read('requireReason');
  const timeout = read('defaultTimeoutDuration');
  const banDays = read('defaultBanDeleteDays');

  const forced = typeof requireReason === 'boolean' ? { forceReason: requireReason } : null;
  const timeoutDefault = typeof timeout === 'string' ? { defaultDuration: timeout } : null;
  const banDelete = typeof banDays === 'number' ? { deleteMessageDays: banDays } : null;

  if (!forced && !timeoutDefault && !banDelete) return null;

  const types: Record<string, Record<string, unknown>> = {};
  for (const direction of PUNISH_DIRECTIONS) types[direction] = { ...forced };

  types.timeout = { ...types.timeout, ...timeoutDefault };
  types.ban = { ...types.ban, ...banDelete };

  return { types };
}

// v2's flat keys count only when there is no punish to carry: a stale tab must not undo per-type.
export function liftStoredConfig(raw: unknown, current?: Record<string, unknown>): unknown {
  const source = record(raw);
  if (!source) return raw;

  const lifted: Record<string, unknown> = { ...source };
  let changed = false;

  if (current !== undefined && !('escalationWindow' in source) && !('escalationLadder' in source)) {
    lifted.escalationWindow = current.escalationWindow;
    lifted.escalationLadder = current.escalationLadder;
    changed = true;
  }

  if (source.punish === undefined) {
    const punish = record(current?.punish) ?? legacyPunish(source, current);
    if (punish) {
      lifted.punish = punish;
      changed = true;
    }
  }

  if (source.reports === undefined && current?.reports !== undefined) {
    lifted.reports = current.reports;
    changed = true;
  }

  return changed ? lifted : raw;
}

export const moderationDefaultConfig: ModerationConfig = {
  enabled: true,
  publicReplies: false,
  escalationWindow: '30d',
  escalationLadder: [
    { atWarnings: 3, action: 'timeout', duration: '1h' },
    { atWarnings: 5, action: 'timeout', duration: '1d' },
  ],
  punish: PUNISH_DEFAULTS,
  reports: REPORTS_DEFAULTS,
};

export const MODERATION_SCHEMA_VERSION = 3;

function writeIssues(config: ModerationConfig): ConfigWriteIssue[] {
  return [...refinePunishWrite(config.punish), ...refineReportsWrite(config.reports)];
}

// A stored issue never blocks saving the rest: a lifted v2 row can hold a timeout past 28 days.
export function refineModerationWrite(
  next: ModerationConfig,
  before: ModerationConfig,
): ConfigWriteIssue[] {
  const standing = new Set(writeIssues(before).map((issue) => `${issue.path}\n${issue.message}`));

  return writeIssues(next).filter((issue) => !standing.has(`${issue.path}\n${issue.message}`));
}
