import type { CaseInput, CaseRecorder } from '@proton/core';
import { newCaseId, redactSecrets } from '@proton/core';
import { sql } from 'drizzle-orm';
import type { DbHandle } from './client.ts';
import { cases } from './schema/cases.ts';

const UNIQUE_VIOLATION = '23505';

const CASE_PKEY = 'cases_pkey';

// A 7-character id has 62^7 values, which is plenty per guild and still finite across every guild
// Proton is in. The primary key is the arbiter: on the rare clash the id is redrawn rather than
// the case being lost, and only a clash on the id is retried — a duplicate idempotency key is a
// redelivery and must still surface.
const ID_ATTEMPTS = 5;

function isCaseIdCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { code, constraint_name: constraint } = error as {
    code?: unknown;
    constraint_name?: unknown;
  };

  return code === UNIQUE_VIOLATION && constraint === CASE_PKEY;
}

export class DrizzleCaseRecorder implements CaseRecorder {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async record(input: CaseInput): Promise<{ caseId: string }> {
    for (let attempt = 1; ; attempt++) {
      const caseId = newCaseId();

      try {
        await this.#insert(caseId, input);
        return { caseId };
      } catch (error) {
        if (attempt >= ID_ATTEMPTS || !isCaseIdCollision(error)) throw error;
      }
    }
  }

  async #insert(caseId: string, input: CaseInput): Promise<void> {
    await this.#handle.db.insert(cases).values({
      id: caseId,
      guildId: input.guildId,

      caseNumber: sql<number>`(select coalesce(max(${cases.caseNumber}), 0) + 1 from ${cases} where ${cases.guildId} = ${input.guildId})`,
      type: input.kind,
      actorId: input.actorId,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      moduleId: input.moduleId,
      payload: input.payload === undefined ? null : redactSecrets(input.payload),
      expiresAt: input.expiresAt ?? null,
      dryRun: input.dryRun,
      idempotencyKey: input.idempotencyKey,
    });
  }
}
