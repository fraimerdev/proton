import { z } from 'zod';
import { ACTION_KINDS, type ActionKind } from './kinds.ts';

export const MODULE_JOB_KIND = 'module_job';

export const scheduledReversalPayloadSchema = z.object({
  kind: z.literal('reversal'),

  caseId: z.string().min(1),
  moduleId: z.string().min(1),

  actorId: z.string().min(1),
  targetId: z.string().min(1).optional(),

  reason: z.string().max(512).optional(),

  originalKind: z.enum(ACTION_KINDS),

  action: z.unknown(),
});

export const scheduledModulePayloadSchema = z.object({
  kind: z.literal('module'),

  moduleId: z.string().min(1),
  jobId: z.string().min(1),
  guildId: z.string().min(1),

  data: z.unknown(),
});

export const scheduledActionPayloadSchema = z.preprocess(
  // every row written before the discriminator existed is a reversal, and still has to lift
  (value) =>
    typeof value === 'object' && value !== null && !('kind' in value)
      ? { ...value, kind: 'reversal' }
      : value,
  z.discriminatedUnion('kind', [scheduledReversalPayloadSchema, scheduledModulePayloadSchema]),
);

export type ScheduledReversalPayload = z.infer<typeof scheduledReversalPayloadSchema>;
export type ScheduledModulePayload = z.infer<typeof scheduledModulePayloadSchema>;
export type ScheduledActionPayload = z.infer<typeof scheduledActionPayloadSchema>;

const KEY_SEPARATOR = ':';
const KEY_ESCAPE = '\\';

function escapeKeySegment(segment: string): string {
  let escaped = '';
  for (const character of segment) {
    if (character === KEY_ESCAPE || character === KEY_SEPARATOR) escaped += KEY_ESCAPE;
    escaped += character;
  }
  return escaped;
}

export function moduleScheduleKey(
  moduleId: string,
  jobId: string,
  guildId: string,
  naturalKey: string,
): string {
  return [moduleId, jobId, guildId, naturalKey].map(escapeKeySegment).join(KEY_SEPARATOR);
}

export interface ScheduledActionInput {
  guildId: string;

  runAt: Date;
  kind: ActionKind | typeof MODULE_JOB_KIND;
  idempotencyKey: string;
  payload: ScheduledActionPayload;

  onConflict?: 'keep' | 'replace';
}

export interface ScheduleOptions {
  replace?: boolean;
}

export interface ScheduleOutcome {
  scheduled: boolean;
  replaced: boolean;
}

export type CompleteOutcome = 'retired' | 'lost';

export interface ScheduledActionRecord {
  id: string;
  guildId: string;
  runAt: Date;
  kind: string;

  attempts: number;
  idempotencyKey: string;
  payload: unknown;

  lockToken: string;
}

export interface ClaimDueOptions {
  now: Date;

  lockUntil: Date;
  limit: number;

  maxAttempts: number;
}

export interface ScheduledActionStore {
  schedule(input: ScheduledActionInput): Promise<ScheduleOutcome>;

  claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]>;

  renew(scheduledActionId: string, lockToken: string, lockUntil: Date): Promise<boolean>;

  complete(scheduledActionId: string, lockToken: string): Promise<CompleteOutcome>;

  completeAndSchedule(
    scheduledActionId: string,
    lockToken: string,
    next: Omit<ScheduledActionInput, 'onConflict'>,
  ): Promise<CompleteOutcome>;

  cancel(idempotencyKey: string): Promise<{ cancelled: boolean }>;

  release(scheduledActionId: string, lockToken: string): Promise<void>;
}
