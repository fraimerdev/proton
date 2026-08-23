import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ScheduledActionInput, ScheduledReversalPayload } from '@proton/core';
import { AUTO_REVERSAL_ACTOR, newId } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { DrizzleScheduledActionStore } from '../src/scheduled-action-store.ts';
import { cases, guilds, scheduledActions } from '../src/schema/index.ts';
import { firstRow } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleScheduledActionStore;

const GUILD = '900000000000000001';
const TARGET = '400000000000000000';
const MOD = '100000000000000000';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const DUE = new Date('2026-08-14T11:00:00.000Z');
const LATER = new Date('2026-08-14T13:00:00.000Z');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleScheduledActionStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from scheduled_actions`;
  await handle.client`delete from cases`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

function reversalPayload(caseId = newId()): ScheduledReversalPayload {
  return {
    kind: 'reversal',
    caseId,
    moduleId: 'moderation',
    actorId: MOD,
    targetId: TARGET,
    originalKind: 'ban',
    action: { userId: TARGET },
    reason: 'Temporary ban expired.',
  };
}

function input(overrides: Partial<ScheduledActionInput> = {}): ScheduledActionInput {
  return {
    guildId: GUILD,
    runAt: DUE,
    kind: 'unban',
    idempotencyKey: `reversal:${newId()}`,
    payload: reversalPayload(),
    ...overrides,
  };
}

const claim = (overrides: Partial<Parameters<typeof store.claimDue>[0]> = {}) =>
  store.claimDue({ now: NOW, lockUntil: LATER, limit: 10, maxAttempts: 5, ...overrides });

const stored = () => handle.db.select().from(scheduledActions);

describe('DrizzleScheduledActionStore.schedule', () => {
  test('stores the payload as queryable jsonb', async () => {
    await store.schedule(input({ idempotencyKey: 'reversal:k1' }));

    const row = await firstRow<{ kind: string; original: string; user: string }>(handle.client`
      select jsonb_typeof(payload) as kind,
             payload->>'originalKind' as original,
             payload->'action'->>'userId' as "user"
        from scheduled_actions where idempotency_key = 'reversal:k1'
    `);

    expect(row.kind).toBe('object');
    expect(row.original).toBe('ban');
    expect(row.user).toBe(TARGET);
  });

  test('a repeat of the same derived key inserts nothing and says so', async () => {
    const first = await store.schedule(input({ idempotencyKey: 'reversal:k1' }));
    const second = await store.schedule(input({ idempotencyKey: 'reversal:k1' }));

    expect(first.scheduled).toBe(true);
    expect(second.scheduled).toBe(false);

    expect(await stored()).toHaveLength(1);
  });

  test('a credential a module put in the payload is redacted before the row is written', async () => {
    await store.schedule(
      input({
        kind: 'module_job',
        idempotencyKey: 'webhooks:post:900000000000000001:abc',
        payload: {
          kind: 'module',
          moduleId: 'webhooks',
          jobId: 'post',
          guildId: GUILD,
          data: {
            url: 'https://example.invalid',
            token: 'super-secret',
            nested: [{ password: 'p' }],
          },
        },
      }),
    );

    const row = await firstRow<{ token: string; password: string; url: string }>(handle.client`
      select payload->'data'->>'token' as token,
             payload->'data'->'nested'->0->>'password' as password,
             payload->'data'->>'url' as url
        from scheduled_actions where idempotency_key = 'webhooks:post:900000000000000001:abc'
    `);

    expect(row.token).toBe('[redacted]');
    expect(row.password).toBe('[redacted]');
    expect(row.url).toBe('https://example.invalid');
  });
});

describe('DrizzleScheduledActionStore.claimDue', () => {
  test('claims a due row, increments attempts and takes the lock', async () => {
    await store.schedule(input());

    const claimed = await claim();

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe('unban');
    expect(claimed[0]?.guildId).toBe(GUILD);

    expect(claimed[0]?.attempts).toBe(1);

    expect(claimed[0]?.runAt).toEqual(DUE);

    const [row] = await stored();
    expect(row?.lockedUntil).toEqual(LATER);
    expect(row?.lockToken).toBe(claimed[0]?.lockToken ?? '');
  });

  test('every row in a batch is stamped with its own fresh token', async () => {
    for (let i = 0; i < 3; i += 1) {
      await store.schedule(input({ idempotencyKey: `reversal:k${i}` }));
    }

    const claimed = await claim();
    const tokens = claimed.map((row) => row.lockToken);

    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
    expect(tokens.every((token) => token.length > 0)).toBe(true);
  });

  test('a second claim of the same row stamps a token the first claim cannot guess', async () => {
    await store.schedule(input());

    const first = await claim();
    const second = await claim({ now: new Date(LATER.getTime() + 1000) });

    expect(second).toHaveLength(1);
    expect(second[0]?.lockToken).not.toBe(first[0]?.lockToken ?? '');
  });

  test('leaves a row whose run_at is still in the future', async () => {
    await store.schedule(input({ runAt: LATER }));

    expect(await claim()).toHaveLength(0);
  });

  test('a locked row is invisible until its lock expires', async () => {
    await store.schedule(input());
    await claim();

    expect(await claim()).toHaveLength(0);

    const after = await claim({ now: new Date(LATER.getTime() + 1000) });
    expect(after).toHaveLength(1);
    expect(after[0]?.attempts).toBe(2);
  });

  test('concurrent claims split the rows, never share one', async () => {
    for (let i = 0; i < 6; i += 1) {
      await store.schedule(input({ idempotencyKey: `reversal:k${i}` }));
    }

    const [a, b] = await Promise.all([claim(), claim()]);

    const ids = [...a, ...b].map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  test('stops claiming a row once it has burned its attempts', async () => {
    await store.schedule(input());

    const first = await claim({ maxAttempts: 2 });
    expect(first).toHaveLength(1);

    await store.release(first[0]?.id ?? '', first[0]?.lockToken ?? '');
    expect(await claim({ maxAttempts: 2 })).toHaveLength(1);

    await handle.db.update(scheduledActions).set({ lockedUntil: null });
    expect(await claim({ maxAttempts: 2 })).toHaveLength(0);

    expect(await stored()).toHaveLength(1);
  });
});

describe('DrizzleScheduledActionStore.cancel', () => {
  test('removes a pending row by its idempotency key and reports whether it was there', async () => {
    await store.schedule(input({ idempotencyKey: 'reminders:remind:1:2' }));

    expect(await store.cancel('reminders:remind:1:2')).toEqual({ cancelled: true });
    expect(await stored()).toHaveLength(0);

    expect(await store.cancel('reminders:remind:1:2')).toEqual({ cancelled: false });
  });

  test('leaves every other pending row alone', async () => {
    await store.schedule(input({ idempotencyKey: 'k1' }));
    await store.schedule(input({ idempotencyKey: 'k2' }));

    await store.cancel('k1');

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe('k2');
  });
});

describe('DrizzleScheduledActionStore.complete and markReverted', () => {
  async function seedCase(id: string): Promise<void> {
    await handle.db.insert(cases).values({
      id,
      guildId: GUILD,
      caseNumber: 1,
      type: 'ban',
      actorId: MOD,
      targetId: TARGET,
      moduleId: 'moderation',
      expiresAt: DUE,
      idempotencyKey: newId(),
    });
  }

  const storedCase = async (id: string) =>
    (await handle.db.select().from(cases).where(eq(cases.id, id)))[0];

  test('retires the row and stamps the case it reversed', async () => {
    const caseId = newId();
    await seedCase(caseId);
    await store.schedule(input({ payload: reversalPayload(caseId) }));
    const claimed = await claim();

    await store.markReverted({ caseId, revertedAt: NOW, revertedBy: AUTO_REVERSAL_ACTOR });
    await store.complete(claimed[0]?.id ?? '', claimed[0]?.lockToken ?? '');

    const row = await storedCase(caseId);
    expect(row?.revertedAt).toEqual(NOW);
    expect(row?.revertedBy).toBe(AUTO_REVERSAL_ACTOR);
    expect(await stored()).toHaveLength(0);
  });

  test('retires a module job row that carries no case at all', async () => {
    await store.schedule(
      input({
        kind: 'module_job',
        idempotencyKey: 'giveaways:end:900000000000000001:abc',
        payload: {
          kind: 'module',
          moduleId: 'giveaways',
          jobId: 'end',
          guildId: GUILD,
          data: { messageId: '42' },
        },
      }),
    );
    const claimed = await claim();

    await store.complete(claimed[0]?.id ?? '', claimed[0]?.lockToken ?? '');

    expect(await stored()).toHaveLength(0);
  });

  test('never overwrites a reversal a moderator already performed', async () => {
    const caseId = newId();
    await seedCase(caseId);
    await handle.db
      .update(cases)
      .set({ revertedAt: DUE, revertedBy: MOD })
      .where(eq(cases.id, caseId));
    await store.schedule(input({ payload: reversalPayload(caseId) }));
    const claimed = await claim();

    await store.markReverted({ caseId, revertedAt: NOW, revertedBy: AUTO_REVERSAL_ACTOR });
    await store.complete(claimed[0]?.id ?? '', claimed[0]?.lockToken ?? '');

    const row = await storedCase(caseId);
    expect(row?.revertedBy).toBe(MOD);
    expect(row?.revertedAt).toEqual(DUE);

    expect(await stored()).toHaveLength(0);
  });
});

describe('DrizzleScheduledActionStore.release', () => {
  test('clears the lock so the next sweep retries immediately', async () => {
    await store.schedule(input());
    const claimed = await claim();

    await store.release(claimed[0]?.id ?? '', claimed[0]?.lockToken ?? '');

    const [released] = await stored();
    expect(released?.lockToken).toBeNull();

    const retry = await claim();
    expect(retry).toHaveLength(1);
    expect(retry[0]?.attempts).toBe(2);
  });

  test('a token that has been superseded frees nothing', async () => {
    await store.schedule(input());
    const first = await claim();
    const second = await claim({ now: new Date(LATER.getTime() + 1000) });

    await store.release(first[0]?.id ?? '', first[0]?.lockToken ?? '');

    const [row] = await stored();
    expect(row?.lockToken).toBe(second[0]?.lockToken ?? '');
    expect(row?.lockedUntil).not.toBeNull();
  });
});

describe('DrizzleScheduledActionStore lock tokens', () => {
  test('renew extends the lock for the holder and refuses a superseded one', async () => {
    await store.schedule(input());
    const first = await claim();
    const later = new Date(LATER.getTime() + 60_000);

    expect(await store.renew(first[0]?.id ?? '', first[0]?.lockToken ?? '', later)).toBe(true);
    expect((await stored())[0]?.lockedUntil).toEqual(later);

    const second = await claim({ now: new Date(later.getTime() + 1000) });
    expect(await store.renew(first[0]?.id ?? '', first[0]?.lockToken ?? '', later)).toBe(false);
    expect(await store.renew(second[0]?.id ?? '', second[0]?.lockToken ?? '', later)).toBe(true);
  });

  test('a superseded token cannot retire the row the current holder is running', async () => {
    await store.schedule(input());
    const first = await claim();
    const second = await claim({ now: new Date(LATER.getTime() + 1000) });

    expect(await store.complete(first[0]?.id ?? '', first[0]?.lockToken ?? '')).toBe('lost');
    expect(await stored()).toHaveLength(1);

    expect(await store.complete(second[0]?.id ?? '', second[0]?.lockToken ?? '')).toBe('retired');
    expect(await stored()).toHaveLength(0);
  });

  test('completing a row that is already gone reports the loss rather than guessing', async () => {
    await store.schedule(input());
    const claimed = await claim();
    await store.cancel(claimed[0]?.idempotencyKey ?? '');

    expect(await store.complete(claimed[0]?.id ?? '', claimed[0]?.lockToken ?? '')).toBe('lost');
  });
});

describe('DrizzleScheduledActionStore.completeAndSchedule', () => {
  const nextRun = new Date(LATER.getTime() + 3600_000);

  test('retires the running row and inserts its successor with a fresh retry budget', async () => {
    await store.schedule(input({ idempotencyKey: 'reminders:remind:1:2' }));
    const claimed = await claim();

    const outcome = await store.completeAndSchedule(
      claimed[0]?.id ?? '',
      claimed[0]?.lockToken ?? '',
      input({ idempotencyKey: 'reminders:remind:1:2', runAt: nextRun }),
    );

    expect(outcome).toBe('retired');

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(claimed[0]?.id ?? '');
    expect(rows[0]?.runAt).toEqual(nextRun);
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.lockedUntil).toBeNull();
    expect(rows[0]?.lockToken).toBeNull();
  });

  test('writes nothing at all once the lease has been lost', async () => {
    await store.schedule(input({ idempotencyKey: 'reminders:remind:1:2' }));
    const first = await claim();
    const second = await claim({ now: new Date(LATER.getTime() + 1000) });

    const outcome = await store.completeAndSchedule(
      first[0]?.id ?? '',
      first[0]?.lockToken ?? '',
      input({ idempotencyKey: 'reminders:remind:1:2', runAt: nextRun }),
    );

    expect(outcome).toBe('lost');

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(second[0]?.id ?? '');
    expect(rows[0]?.runAt).toEqual(DUE);
  });
});
