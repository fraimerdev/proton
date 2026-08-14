import type { CaseInput, CaseRecorder } from '@proton/core';
import { newId } from '@proton/core';
import { sql } from 'drizzle-orm';
import type { DbHandle } from './client.ts';
import { cases } from './schema/cases.ts';

/**
 * Postgres implementation of the action ledger port.
 *
 * Case numbers are allocated inside the INSERT rather than read-then-written, so
 * two concurrent actions in one guild cannot both compute the same next number
 * and race. If they do collide, the UNIQUE(guild_id, case_number) constraint
 * rejects one and the caller retries — which is the correct outcome.
 */
export class DrizzleCaseRecorder implements CaseRecorder {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async record(input: CaseInput): Promise<{ caseId: string }> {
    const caseId = newId();

    await this.#handle.db.insert(cases).values({
      id: caseId,
      guildId: input.guildId,
      // Allocated in-statement rather than read-then-written. Drizzle serialises
      // the jsonb column itself; hand-rolling `${JSON.stringify(x)}::jsonb`
      // double-encodes it into a jsonb *string*, so `payload->>'key'` is null.
      caseNumber: sql<number>`(select coalesce(max(${cases.caseNumber}), 0) + 1 from ${cases} where ${cases.guildId} = ${input.guildId})`,
      type: input.kind,
      actorId: input.actorId,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      moduleId: input.moduleId,
      payload: input.payload ?? null,
      dryRun: input.dryRun,
      idempotencyKey: input.idempotencyKey,
    });

    return { caseId };
  }
}
