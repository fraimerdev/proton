import type { ActionKind } from './types.ts';

export interface CaseInput {
  guildId: string;
  moduleId: string;
  kind: ActionKind;
  actorId: string;
  targetId?: string | undefined;
  reason?: string | undefined;
  payload?: unknown;
  dryRun: boolean;
  idempotencyKey: string;
}

/**
 * Persistence port for the action ledger.
 *
 * Declared here rather than importing `@proton/db` so `packages/core` stays free
 * of a database dependency — the executor is pure logic over ports. The Drizzle
 * implementation lives in `@proton/db`, and tests use an in-memory one.
 */
export interface CaseRecorder {
  /**
   * Persist a case and return its id.
   *
   * Implementations must surface a unique-violation on `idempotencyKey` as a
   * thrown error, so the executor can distinguish "already done" from "failed".
   */
  record(input: CaseInput): Promise<{ caseId: string }>;
}
