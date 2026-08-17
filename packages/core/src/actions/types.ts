import { z } from 'zod';
import { ACTION_KINDS, type ActionKind } from './kinds.ts';

export { ACTION_KINDS, type ActionKind } from './kinds.ts';

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

  record?: boolean;
}

export type ActionStatus =
  | 'executed'
  | 'dry_run'
  | 'skipped_duplicate'
  | 'failed_precheck'
  | 'failed_api';

export interface ActionFailure {
  code: string;

  humanReason: string;
}

export interface ActionResult {
  caseId?: string;
  status: ActionStatus;
  // Discord's response, on `executed` only. A create returns the id of what it made, and without
  // this the only way back to it is to list and guess — which is what starboard used to do.
  body?: unknown;

  failure?: ActionFailure;
}

export interface ActionExecutor {
  execute(request: ActionRequest): Promise<ActionResult>;
}

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

  record: z.boolean().optional(),
});

export * from './payloads.ts';
