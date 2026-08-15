import { z } from 'zod';
import { ACTION_KINDS, type ActionKind } from './kinds.ts';

export const scheduledReversalPayloadSchema = z.object({
  caseId: z.string().min(1),
  moduleId: z.string().min(1),

  actorId: z.string().min(1),
  targetId: z.string().min(1).optional(),

  reason: z.string().max(512).optional(),

  originalKind: z.enum(ACTION_KINDS),

  action: z.unknown(),
});

export type ScheduledReversalPayload = z.infer<typeof scheduledReversalPayloadSchema>;

export interface ScheduledActionInput {
  guildId: string;

  runAt: Date;
  kind: ActionKind;
  idempotencyKey: string;
  payload: ScheduledReversalPayload;
}

export interface ScheduledActionRecord {
  id: string;
  guildId: string;
  runAt: Date;
  kind: string;

  attempts: number;
  idempotencyKey: string;
  payload: unknown;
}

export interface ClaimDueOptions {
  now: Date;

  lockUntil: Date;
  limit: number;

  maxAttempts: number;
}

export interface CompleteReversalInput {
  scheduledActionId: string;
  caseId: string;
  revertedAt: Date;
  revertedBy: string;
}

export interface ScheduledActionStore {
  schedule(input: ScheduledActionInput): Promise<{ scheduled: boolean }>;

  claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]>;

  complete(input: CompleteReversalInput): Promise<void>;

  release(scheduledActionId: string): Promise<void>;
}
