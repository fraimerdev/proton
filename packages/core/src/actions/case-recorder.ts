import type { ActionKind } from './types.ts';

export interface CaseInput {
  guildId: string;
  moduleId: string;
  kind: ActionKind;
  actorId: string;
  targetId?: string | undefined;
  reason?: string | undefined;
  payload?: unknown;

  expiresAt?: Date | undefined;
  dryRun: boolean;
  idempotencyKey: string;
}

export interface CaseRecorder {
  record(input: CaseInput): Promise<{ caseId: string }>;
}
