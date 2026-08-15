import { z } from 'zod';
import { ACTION_KINDS, type ActionKind } from './kinds.ts';

export { ACTION_KINDS, type ActionKind } from './kinds.ts';

/** Verbatim from PLAN.md §4-P3. */
export interface ActionRequest {
  guildId: string;
  moduleId: string;
  kind: ActionKind;
  targetId?: string;
  actorId: string;
  reason?: string;
  payload?: unknown;
  expiresAt?: Date;
  dryRun: boolean;
  idempotencyKey: string;
}

export type ActionStatus =
  | 'executed'
  | 'dry_run'
  | 'skipped_duplicate'
  | 'failed_precheck'
  | 'failed_api';

export interface ActionFailure {
  code: string;
  /** Surfaced verbatim to the invoker (PLAN.md §1) — must name what and where. */
  humanReason: string;
}

export interface ActionResult {
  caseId?: string;
  status: ActionStatus;
  /**
   * Why the action did not happen — or, on an `executed` result, what *else*
   * did not happen. A temporary action whose reversal could not be scheduled
   * succeeded and still needs telling about, so branch on `status`, never on
   * the presence of this field.
   */
  failure?: ActionFailure;
}

export interface ActionExecutor {
  execute(request: ActionRequest): Promise<ActionResult>;
}

/**
 * An executor that can bind per-invocation context (an interaction's
 * `app_permissions`, its resolved members) without modules ever seeing it.
 */
export interface ScopedActionExecutor extends ActionExecutor {
  scoped(hints: unknown): ActionExecutor;
}

export function isScopedActionExecutor(executor: ActionExecutor): executor is ScopedActionExecutor {
  return typeof (executor as Partial<ScopedActionExecutor>).scoped === 'function';
}

export const actionRequestSchema = z.object({
  guildId: z.string().min(1),
  moduleId: z.string().min(1),
  kind: z.enum(ACTION_KINDS),
  targetId: z.string().min(1).optional(),
  actorId: z.string().min(1),
  reason: z.string().max(512).optional(),
  payload: z.unknown().optional(),
  expiresAt: z.date().optional(),
  dryRun: z.boolean(),
  idempotencyKey: z.string().min(1),
});

export * from './payloads.ts';
