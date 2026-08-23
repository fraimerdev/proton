import { describe, expect, test } from 'bun:test';
import { CASE_ID_LENGTH } from '@proton/core';
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

/** A handle whose insert runs `onInsert` with the row, so a test can reject the first attempt. */
function handleThat(onInsert: (row: { id: string }) => void): {
  handle: DbHandle;
  ids: string[];
} {
  const ids: string[] = [];

  const handle = {
    db: {
      insert: () => ({
        values: async (row: { id: string }) => {
          ids.push(row.id);
          onInsert(row);
        },
      }),
    },
  } as unknown as DbHandle;

  return { handle, ids };
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
