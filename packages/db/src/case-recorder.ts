import type { CaseInput, CaseRecorder } from '@proton/core';
import { newId } from '@proton/core';
import { sql } from 'drizzle-orm';
import type { DbHandle } from './client.ts';
import { cases } from './schema/cases.ts';

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

      caseNumber: sql<number>`(select coalesce(max(${cases.caseNumber}), 0) + 1 from ${cases} where ${cases.guildId} = ${input.guildId})`,
      type: input.kind,
      actorId: input.actorId,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      moduleId: input.moduleId,
      payload: input.payload ?? null,
      expiresAt: input.expiresAt ?? null,
      dryRun: input.dryRun,
      idempotencyKey: input.idempotencyKey,
    });

    return { caseId };
  }
}
