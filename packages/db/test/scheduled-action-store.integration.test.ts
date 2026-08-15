import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ScheduledActionInput } from '@proton/core';
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

function input(overrides: Partial<ScheduledActionInput> = {}): ScheduledActionInput {
  return {
    guildId: GUILD,
    runAt: DUE,
    kind: 'unban',
    idempotencyKey: `reversal:${newId()}`,
    payload: {
      caseId: newId(),
      moduleId: 'moderation',
      actorId: MOD,
      targetId: TARGET,
      originalKind: 'ban',
      action: { userId: TARGET },
      reason: 'Temporary ban expired.',
    },
    ...overrides,
  };
}

const claim = (overrides: Partial<Parameters<typeof store.claimDue>[0]> = {}) =>
  store.claimDue({ now: NOW, lockUntil: LATER, limit: 10, maxAttempts: 5, ...overrides });

/**
 * Read stored rows through Drizzle rather than the raw client: Drizzle's own
 * driver setup disables postgres.js timestamp parsing on the shared connection,
 * so only its column mappers hand back real `Date`s. See client.ts.
 */
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

    // Regression guard for the driver-level double-encoding in client.ts: as a
    // jsonb string scalar these extractions return null and the sweeper would
    // reject its own rows as malformed.
    expect(row.kind).toBe('object');
    expect(row.original).toBe('ban');
    expect(row.user).toBe(TARGET);
  });

  /**
   * The scheduler runs once per executed action, and a redelivered gateway event
   * can execute the same logical action twice past the dedupe window. Two rows
   * would mean two unbans.
   */
  test('a repeat of the same derived key inserts nothing and says so', async () => {
    const first = await store.schedule(input({ idempotencyKey: 'reversal:k1' }));
    const second = await store.schedule(input({ idempotencyKey: 'reversal:k1' }));

    expect(first.scheduled).toBe(true);
    expect(second.scheduled).toBe(false);

    expect(await stored()).toHaveLength(1);
  });
});

describe('DrizzleScheduledActionStore.claimDue', () => {
  test('claims a due row, increments attempts and takes the lock', async () => {
    await store.schedule(input());

    const claimed = await claim();

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe('unban');
    expect(claimed[0]?.guildId).toBe(GUILD);
    // Already incremented, so `1` reads as "this is the first attempt".
    expect(claimed[0]?.attempts).toBe(1);

    expect(claimed[0]?.runAt).toEqual(DUE);

    const [row] = await stored();
    expect(row?.lockedUntil).toEqual(LATER);
  });

  test('leaves a row whose run_at is still in the future', async () => {
    await store.schedule(input({ runAt: LATER }));

    expect(await claim()).toHaveLength(0);
  });

  test('a locked row is invisible until its lock expires', async () => {
    await store.schedule(input());
    await claim();

    // Same instant: the first sweeper still holds it.
    expect(await claim()).toHaveLength(0);

    // Past the lock: the claim is presumed dead and the work is reclaimed, which
    // is what stops a worker crashing mid-reversal from stranding the row.
    const after = await claim({ now: new Date(LATER.getTime() + 1000) });
    expect(after).toHaveLength(1);
    expect(after[0]?.attempts).toBe(2);
  });

  /**
   * The atomic half of the design. Two sweepers hitting one row must not both
   * receive it — a double claim is a double unban.
   */
  test('concurrent claims split the rows, never share one', async () => {
    for (let i = 0; i < 6; i += 1) {
      await store.schedule(input({ idempotencyKey: `reversal:k${i}` }));
    }

    const [a, b] = await Promise.all([claim(), claim()]);

    const ids = [...a, ...b].map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  /**
   * Without this bound a permanently failing reversal — a user whose account no
   * longer exists — issues a REST call every sweep, forever.
   */
  test('stops claiming a row once it has burned its attempts', async () => {
    await store.schedule(input());

    const first = await claim({ maxAttempts: 2 });
    expect(first).toHaveLength(1);

    await store.release(first[0]?.id ?? '');
    expect(await claim({ maxAttempts: 2 })).toHaveLength(1);

    // attempts is now 2 and nothing else will pick it up.
    await handle.db.update(scheduledActions).set({ lockedUntil: null });
    expect(await claim({ maxAttempts: 2 })).toHaveLength(0);

    // The row survives as the record of what never happened.
    expect(await stored()).toHaveLength(1);
  });
});

describe('DrizzleScheduledActionStore.complete', () => {
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
    await store.schedule(input({ payload: { ...input().payload, caseId } }));
    const claimed = await claim();

    await store.complete({
      scheduledActionId: claimed[0]?.id ?? '',
      caseId,
      revertedAt: NOW,
      revertedBy: AUTO_REVERSAL_ACTOR,
    });

    const row = await storedCase(caseId);
    expect(row?.revertedAt).toEqual(NOW);
    expect(row?.revertedBy).toBe(AUTO_REVERSAL_ACTOR);
    expect(await stored()).toHaveLength(0);
  });

  /**
   * A moderator who lifted the ban by hand owns that record. Overwriting their
   * name and timestamp with the scheduler's would erase who actually did it.
   */
  test('never overwrites a reversal a moderator already performed', async () => {
    const caseId = newId();
    await seedCase(caseId);
    await handle.db
      .update(cases)
      .set({ revertedAt: DUE, revertedBy: MOD })
      .where(eq(cases.id, caseId));
    await store.schedule(input({ payload: { ...input().payload, caseId } }));
    const claimed = await claim();

    await store.complete({
      scheduledActionId: claimed[0]?.id ?? '',
      caseId,
      revertedAt: NOW,
      revertedBy: AUTO_REVERSAL_ACTOR,
    });

    const row = await storedCase(caseId);
    expect(row?.revertedBy).toBe(MOD);
    expect(row?.revertedAt).toEqual(DUE);
    // The row is still retired — there is nothing left to do.
    expect(await stored()).toHaveLength(0);
  });
});

describe('DrizzleScheduledActionStore.release', () => {
  test('clears the lock so the next sweep retries immediately', async () => {
    await store.schedule(input());
    const claimed = await claim();

    await store.release(claimed[0]?.id ?? '');

    const retry = await claim();
    expect(retry).toHaveLength(1);
    expect(retry[0]?.attempts).toBe(2);
  });
});
