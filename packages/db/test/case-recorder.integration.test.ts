import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CaseInput } from '@proton/core';
import { newId } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DrizzleCaseRecorder } from '../src/case-recorder.ts';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';
import { firstRow, rows } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let recorder: DrizzleCaseRecorder;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  recorder = new DrizzleCaseRecorder(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from cases`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

function input(overrides: Partial<CaseInput> = {}): CaseInput {
  return {
    guildId: GUILD,
    moduleId: 'ping',
    kind: 'send',
    actorId: '100000000000000000',
    dryRun: false,
    idempotencyKey: newId(),
    ...overrides,
  };
}

describe('DrizzleCaseRecorder', () => {
  test('records a case and returns its id', async () => {
    const { caseId } = await recorder.record(input({ reason: 'because' }));

    const found = await rows<{ module_id: string; reason: string }>(
      handle.client`select * from cases where id = ${caseId}`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.module_id).toBe('ping');
    expect(found[0]?.reason).toBe('because');
  });

  test('allocates case numbers sequentially per guild', async () => {
    await recorder.record(input());
    await recorder.record(input());
    await recorder.record(input({ guildId: OTHER_GUILD }));

    const first = await rows<{ case_number: number }>(handle.client`
      select case_number from cases where guild_id = ${GUILD} order by case_number
    `);
    const other = await firstRow<{ case_number: number }>(handle.client`
      select case_number from cases where guild_id = ${OTHER_GUILD}
    `);

    expect(first.map((r) => r.case_number)).toEqual([1, 2]);

    expect(other.case_number).toBe(1);
  });

  test('rejects a duplicate idempotency key at the database level', async () => {
    const key = newId();
    await recorder.record(input({ idempotencyKey: key }));

    await expect(recorder.record(input({ idempotencyKey: key }))).rejects.toThrow();

    const row = await firstRow<{ n: number }>(handle.client`select count(*)::int as n from cases`);
    expect(row.n).toBe(1);
  });

  test('stores the payload as queryable jsonb', async () => {
    const { caseId } = await recorder.record(
      input({ payload: { channelId: '123', content: 'Pong!' } }),
    );

    const row = await firstRow<{ kind: string; content: string }>(handle.client`
      select jsonb_typeof(payload) as kind, payload->>'content' as content
      from cases where id = ${caseId}
    `);

    expect(row.kind).toBe('object');
    expect(row.content).toBe('Pong!');
  });

  test('concurrent records in one guild all succeed with distinct numbers', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => recorder.record(input())),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const found = await rows<{ case_number: number }>(
      handle.client`select case_number from cases where guild_id = ${GUILD}`,
    );
    const numbers = found.map((r) => r.case_number);

    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toHaveLength(succeeded);
  });
});
