import { z } from 'zod';
import { ACTION_KINDS, type ActionKind } from './kinds.ts';

/**
 * The JSONB body of a `scheduled_actions` row that reverses a temporary action.
 *
 * Validated on every read, for the same reason I5 validates module config on
 * every read: this row is written by one process and executed by another,
 * possibly after a deploy that changed the shape. A reversal assembled from a
 * half-understood row is a Discord call made on a guess.
 */
export const scheduledReversalPayloadSchema = z.object({
  /** The case being undone. Its `reverted_at` is stamped when this succeeds. */
  caseId: z.string().min(1),
  moduleId: z.string().min(1),
  /** The original action's actor, so the ledger links cause to effect. */
  actorId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  /** Becomes the reversal's Discord audit-log reason. */
  reason: z.string().max(512).optional(),
  /** The kind being undone — for the log line and the dashboard, not for routing. */
  originalKind: z.enum(ACTION_KINDS),
  /**
   * Payload for the reversal kind.
   *
   * Left unknown rather than re-declaring every reversal's schema here:
   * `toRestCall` already validates it against the single definition in
   * `payloads.ts`, and a second copy would drift from the first.
   */
  action: z.unknown(),
});

export type ScheduledReversalPayload = z.infer<typeof scheduledReversalPayloadSchema>;

export interface ScheduledActionInput {
  guildId: string;
  /** When the reversal becomes due — the original action's `expiresAt`. */
  runAt: Date;
  kind: ActionKind;
  idempotencyKey: string;
  payload: ScheduledReversalPayload;
}

/** One `scheduled_actions` row, as the sweeper sees it. */
export interface ScheduledActionRecord {
  id: string;
  guildId: string;
  runAt: Date;
  kind: string;
  /** Already incremented by the claim, so `1` means "this is the first attempt". */
  attempts: number;
  idempotencyKey: string;
  payload: unknown;
}

export interface ClaimDueOptions {
  now: Date;
  /** Rows claimed here are invisible to other sweepers until this instant. */
  lockUntil: Date;
  limit: number;
  /** Rows that have already been tried this many times are left alone. */
  maxAttempts: number;
}

export interface CompleteReversalInput {
  scheduledActionId: string;
  caseId: string;
  revertedAt: Date;
  revertedBy: string;
}

/**
 * Persistence port for §6's `scheduled_actions`.
 *
 * Declared in core so the sweeper stays pure logic over ports, matching
 * `CaseRecorder`. The Drizzle implementation lives in `@proton/db`.
 */
export interface ScheduledActionStore {
  /**
   * Insert a due-at row.
   *
   * Must be idempotent on `idempotencyKey`: a redelivered ban re-runs the
   * scheduler, and two rows would mean two unbans. Returns `false` when the row
   * already existed.
   */
  schedule(input: ScheduledActionInput): Promise<{ scheduled: boolean }>;

  /**
   * Atomically claim the rows that are due, incrementing `attempts` and taking a
   * lock in the same statement. Two sweepers running concurrently must never
   * receive the same row.
   */
  claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]>;

  /**
   * Retire the row and stamp the case it reversed, in one transaction.
   *
   * Together, because a crash between them either re-runs a reversal that
   * already happened (harmless — the idempotency key absorbs it) or leaves a
   * case that reads as still-active with nothing left to revert it (invisible,
   * and therefore the worse half).
   */
  complete(input: CompleteReversalInput): Promise<void>;

  /** Hand a claim back after a failure so the next sweep can retry immediately. */
  release(scheduledActionId: string): Promise<void>;
}
