import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DrizzleAppealStore } from '../src/postgres-store.ts';
import type { FileAppealInput } from '../src/store.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleAppealStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

const MEMBER = '400000000000000001';
const OTHER = '400000000000000002';

const MOD = '100000000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleAppealStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from appeal_answers`;
  await handle.client`delete from appeals`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

function input(overrides: Partial<FileAppealInput> = {}): FileAppealInput {
  return {
    guildId: GUILD,
    userId: MEMBER,
    panelId: 'ban',
    origin: 'honeypot',
    jti: 'honeypot:900000000000000001:1400000000000000001',
    answers: [{ key: 'why', label: 'Why?', value: 'I was hacked' }],
    ...overrides,
  };
}

describe('filing an appeal', () => {
  test('records the answers, numbered from one', async () => {
    const { appeal, filed } = await store.file(input());

    expect(filed).toBe(true);
    expect(appeal.number).toBe(1);
    expect(appeal.status).toBe('open');
    expect(appeal.answers).toEqual([{ key: 'why', label: 'Why?', value: 'I was hacked' }]);
  });

  test('numbers per guild, not globally', async () => {
    await store.file(input());
    const second = await store.file(input({ guildId: OTHER_GUILD, jti: 'other' }));

    expect(second.appeal.number).toBe(1);
  });

  // Opening the same link twice must find the appeal already filed, not file a second one. ON
  // CONFLICT DO NOTHING returns no row, which is why file() selects the row back.
  test('the same link twice is one appeal', async () => {
    const first = await store.file(input());
    const again = await store.file(input());

    expect(again.filed).toBe(false);
    expect(again.appeal.id).toBe(first.appeal.id);
    expect(again.appeal.answers).toHaveLength(1);
  });

  test('one member may have only one appeal open at a time', async () => {
    await store.file(input());

    await expect(store.file(input({ jti: 'a-second-link' }))).rejects.toThrow();
  });

  test('but may file again once the first is decided', async () => {
    const first = await store.file(input());
    await store.decide({
      guildId: GUILD,
      appealId: first.appeal.id,
      decision: 'denied',
      decidedBy: MOD,
    });

    const second = await store.file(input({ jti: 'a-second-link' }));

    expect(second.filed).toBe(true);
    expect(second.appeal.number).toBe(2);
  });
});

describe('deciding one', () => {
  test('records who decided it and when', async () => {
    const { appeal } = await store.file(input());

    const decided = await store.decide({
      guildId: GUILD,
      appealId: appeal.id,
      decision: 'approved',
      decidedBy: MOD,
    });

    expect(decided?.status).toBe('approved');
    expect(decided?.decidedBy).toBe(MOD);
    expect(decided?.decidedAt).not.toBeNull();
  });

  // The conditional UPDATE is the lock: two reviewers pressing at once are two event ids, so the
  // executor's dedupe cannot arbitrate between them.
  test('the second reviewer to press gets nothing back', async () => {
    const { appeal } = await store.file(input());

    const first = await store.decide({
      guildId: GUILD,
      appealId: appeal.id,
      decision: 'approved',
      decidedBy: MOD,
    });

    const second = await store.decide({
      guildId: GUILD,
      appealId: appeal.id,
      decision: 'denied',
      decidedBy: OTHER,
    });

    expect(first?.status).toBe('approved');
    expect(second).toBeNull();
    expect((await store.find(GUILD, appeal.id))?.status).toBe('approved');
  });

  test('is scoped to one guild', async () => {
    const { appeal } = await store.file(input());

    expect(
      await store.decide({
        guildId: OTHER_GUILD,
        appealId: appeal.id,
        decision: 'approved',
        decidedBy: MOD,
      }),
    ).toBeNull();
  });

  test('whether the outcome was carried out is recorded separately from the decision', async () => {
    const { appeal } = await store.file(input());
    await store.decide({
      guildId: GUILD,
      appealId: appeal.id,
      decision: 'approved',
      decidedBy: MOD,
    });

    expect((await store.find(GUILD, appeal.id))?.outcomeApplied).toBe(false);

    await store.markApplied(GUILD, appeal.id);

    expect((await store.find(GUILD, appeal.id))?.outcomeApplied).toBe(true);
  });
});

describe('what the cooldown reads', () => {
  test('is the most recent decision, whatever link produced it', async () => {
    expect(await store.lastDecidedAt(GUILD, MEMBER)).toBeNull();

    const { appeal } = await store.file(input());
    await store.decide({ guildId: GUILD, appealId: appeal.id, decision: 'denied', decidedBy: MOD });

    expect(await store.lastDecidedAt(GUILD, MEMBER)).not.toBeNull();
  });

  test('and is per member', async () => {
    const { appeal } = await store.file(input());
    await store.decide({ guildId: GUILD, appealId: appeal.id, decision: 'denied', decidedBy: MOD });

    expect(await store.lastDecidedAt(GUILD, OTHER)).toBeNull();
  });
});

describe('the crash-safe direct message', () => {
  test('counts each attempt, so a retry does not reuse a dead idempotency key', async () => {
    const { appeal } = await store.file(input());

    expect(await store.noteDmAttempt(GUILD, appeal.id)).toBe(1);
    expect(await store.noteDmAttempt(GUILD, appeal.id)).toBe(2);
  });

  test('remembers the channel it opened, so a redelivery sends rather than re-opens', async () => {
    const { appeal } = await store.file(input());

    await store.rememberDm(GUILD, appeal.id, '800000000000000001');

    expect((await store.find(GUILD, appeal.id))?.dmChannelId).toBe('800000000000000001');
  });
});

describe('the guild foreign key', () => {
  test('takes the appeals and their answers with it', async () => {
    await store.file(input());

    await handle.client`delete from guilds where id = ${GUILD}`;

    const rows = await handle.client`select count(*)::int as n from appeal_answers`;
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
