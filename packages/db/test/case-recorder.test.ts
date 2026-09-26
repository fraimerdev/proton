import { describe, expect, test } from 'bun:test';
import { CASE_ID_LENGTH, reversalIdempotencyKey } from '@proton/core';
import { DrizzleCaseRecorder } from '../src/case-recorder.ts';
import type { DbHandle } from '../src/client.ts';

const INPUT = {
  guildId: '900000000000000001',
  moduleId: 'moderation',
  kind: 'ban' as const,
  actorId: '100000000000000001',
  idempotencyKey: 'event-1:ban',
  dryRun: false,
};

function violation(constraint: string): Error & { code: string; constraint_name: string } {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: '23505',
      constraint_name: constraint,
    },
  );
}

interface InsertedRow {
  id: string;
  actorId: string;
  moderatorId: string | null;
}

/** A handle whose insert runs `onInsert` with the row, so a test can reject the first attempt. */
function handleThat(onInsert: (row: InsertedRow) => void): {
  handle: DbHandle;
  ids: string[];
  rows: InsertedRow[];
} {
  const ids: string[] = [];
  const rows: InsertedRow[] = [];

  const handle = {
    db: {
      insert: () => ({
        values: async (row: InsertedRow) => {
          ids.push(row.id);
          rows.push(row);
          onInsert(row);
        },
      }),
    },
  } as unknown as DbHandle;

  return { handle, ids, rows };
}

describe('DrizzleCaseRecorder', () => {
  test('records under a seven-character case id', async () => {
    const { handle, ids } = handleThat(() => undefined);

    const { caseId } = await new DrizzleCaseRecorder(handle).record(INPUT);

    expect(caseId).toHaveLength(CASE_ID_LENGTH);
    expect(ids).toEqual([caseId]);
  });

  // The whole point of a short id: two cases can draw the same one, and the second must get a new
  // id rather than an error the moderator sees instead of their ban being recorded.
  test('redraws the id when the primary key is already taken', async () => {
    let attempts = 0;
    const { handle, ids } = handleThat(() => {
      attempts += 1;
      if (attempts === 1) throw violation('cases_pkey');
    });

    const { caseId } = await new DrizzleCaseRecorder(handle).record(INPUT);

    expect(attempts).toBe(2);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(caseId).toBe(ids[1] as string);
  });

  test('gives up rather than looping forever when every id collides', async () => {
    const { handle, ids } = handleThat(() => {
      throw violation('cases_pkey');
    });

    await expect(new DrizzleCaseRecorder(handle).record(INPUT)).rejects.toThrow('cases_pkey');
    expect(ids).toHaveLength(5);
  });

  // A redelivered gateway event hits this index, and retrying it would write the same case twice.
  test('never retries a duplicate idempotency key, which is a redelivery, not a clash', async () => {
    const { handle, ids } = handleThat(() => {
      throw violation('cases_idempotency_key_uq');
    });

    await expect(new DrizzleCaseRecorder(handle).record(INPUT)).rejects.toThrow(
      'cases_idempotency_key_uq',
    );
    expect(ids).toHaveLength(1);
  });

  test('the member who ran the action is recorded as its moderator', async () => {
    const { handle, rows } = handleThat(() => undefined);

    await new DrizzleCaseRecorder(handle).record(INPUT);

    expect(rows[0]?.actorId).toBe(INPUT.actorId);
    expect(rows[0]?.moderatorId).toBe(INPUT.actorId);
  });

  test('an automatic action has no moderator, only the pseudo-actor that took it', async () => {
    const { handle, rows } = handleThat(() => undefined);

    await new DrizzleCaseRecorder(handle).record({ ...INPUT, actorId: 'proton:automod' });
    await new DrizzleCaseRecorder(handle).record({ ...INPUT, actorId: 'rules:r1' });

    expect(rows.map((row) => [row.actorId, row.moderatorId])).toEqual([
      ['proton:automod', null],
      ['rules:r1', null],
    ]);
  });

  test('a duration running out has no moderator, though it runs as the one who set it', async () => {
    const { handle, rows } = handleThat(() => undefined);

    await new DrizzleCaseRecorder(handle).record({
      ...INPUT,
      kind: 'unban',
      idempotencyKey: reversalIdempotencyKey(INPUT.idempotencyKey),
    });

    expect(rows.map((row) => [row.actorId, row.moderatorId])).toEqual([[INPUT.actorId, null]]);
  });

  test('a failure that is not a unique violation is not retried either', async () => {
    const { handle, ids } = handleThat(() => {
      throw new Error('connection terminated');
    });

    await expect(new DrizzleCaseRecorder(handle).record(INPUT)).rejects.toThrow(
      'connection terminated',
    );
    expect(ids).toHaveLength(1);
  });
});
