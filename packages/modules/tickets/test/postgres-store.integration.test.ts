import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { DrizzleTicketStore } from '../src/postgres-store.ts';
import type { Ticket } from '../src/store.ts';
import { tickets } from '../src/table.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleTicketStore;

const GUILD = '900000000000000001';
const OPENER = '100000000000000001';
const OWNER = '100000000000000002';
const CHANNEL = '500000000000000001';
const OTHER_CHANNEL = '500000000000000002';
const SOURCE = { module: 'applications', ref: 'app-1' };
const NOW = new Date('2026-09-18T12:00:00.000Z');

function at(second: number): Date {
  return new Date(NOW.getTime() + second * 1_000);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleTicketStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

async function openTicket(): Promise<Ticket> {
  const reserved = await store.reserve({
    guildId: GUILD,
    typeId: 'support',
    panelId: 'panel',
    openerId: OPENER,
    priority: 'medium',
  });
  const attached = await store.attach(GUILD, reserved.id, CHANNEL);
  if (!attached) throw new Error('the reserved ticket was not attached');
  return attached;
}

async function stored(id: string) {
  const [row] = await handle.db.select().from(tickets).where(eq(tickets.id, id));
  if (!row) throw new Error(`ticket ${id} is missing`);
  return row;
}

describe('recording activity', () => {
  test('the first staff reply sets the first-response clock to the reply time', async () => {
    const ticket = await openTicket();

    const returned = await store.recordActivity(GUILD, CHANNEL, { fromStaff: true, at: at(30) });

    expect(returned?.firstResponseAt).toEqual(at(30));

    const row = await stored(ticket.id);
    expect(row.firstResponseAt).toEqual(at(30));
    expect(row.lastStaffMessageAt).toEqual(at(30));
    expect(row.lastActivityAt).toEqual(at(30));
    expect(row.waitingOn).toBe('user');
    expect(row.messageCount).toBe(0);
  });

  test('a later staff reply moves the last staff message but not the first response', async () => {
    const ticket = await openTicket();

    await store.recordActivity(GUILD, CHANNEL, { fromStaff: true, at: at(30) });
    await store.recordActivity(GUILD, CHANNEL, { fromStaff: true, at: at(90) });

    const row = await stored(ticket.id);
    expect(row.firstResponseAt).toEqual(at(30));
    expect(row.lastStaffMessageAt).toEqual(at(90));
    expect(row.lastActivityAt).toEqual(at(90));
  });

  test('a member message counts and leaves the first-response clock alone', async () => {
    const ticket = await openTicket();

    await store.recordActivity(GUILD, CHANNEL, { fromStaff: false, at: at(10) });
    await store.recordActivity(GUILD, CHANNEL, { fromStaff: false, at: at(20) });

    const row = await stored(ticket.id);
    expect(row.firstResponseAt).toBeNull();
    expect(row.lastUserMessageAt).toEqual(at(20));
    expect(row.lastActivityAt).toEqual(at(20));
    expect(row.waitingOn).toBe('staff');
    expect(row.messageCount).toBe(2);
  });
});

function reserveSourced(): Promise<Ticket> {
  return store.reserve({
    guildId: GUILD,
    typeId: 'interview',
    panelId: '',
    openerId: OPENER,
    ownerId: OWNER,
    priority: 'medium',
    source: SOURCE,
  });
}

describe('tickets another module asked for', () => {
  test('a reservation records the owner and the source apart from the opener', async () => {
    const reserved = await reserveSourced();

    expect(reserved.openerId).toBe(OPENER);
    expect(reserved.ownerId).toBe(OWNER);
    expect(reserved.source).toEqual(SOURCE);

    const row = await stored(reserved.id);
    expect(row.sourceModule).toBe('applications');
    expect(row.sourceRef).toBe('app-1');
  });

  test('a second reservation for a source with an open ticket returns that ticket', async () => {
    const first = await reserveSourced();
    const second = await reserveSourced();

    expect(second.id).toBe(first.id);
    expect(
      await handle.db.select().from(tickets).where(eq(tickets.sourceRef, 'app-1')),
    ).toHaveLength(1);
  });

  test('two reservations racing for one source end on the same row', async () => {
    const [a, b] = await Promise.all([reserveSourced(), reserveSourced()]);

    expect(a.id).toBe(b.id);
    expect(
      await handle.db.select().from(tickets).where(eq(tickets.sourceRef, 'app-1')),
    ).toHaveLength(1);
  });

  test('a closed ticket frees its source, and bySource prefers the open one', async () => {
    const first = await reserveSourced();
    await store.attach(GUILD, first.id, CHANNEL);
    await store.close({ guildId: GUILD, ticketId: first.id, closedBy: OPENER, reason: null });

    expect((await store.bySource(GUILD, 'applications', 'app-1'))?.id).toBe(first.id);

    const second = await reserveSourced();
    expect(second.id).not.toBe(first.id);
    await store.attach(GUILD, second.id, OTHER_CHANNEL);

    expect((await store.bySource(GUILD, 'applications', 'app-1'))?.id).toBe(second.id);
  });

  test('an older ticket is not reopened over a newer open one for the same source', async () => {
    const first = await reserveSourced();
    await store.attach(GUILD, first.id, CHANNEL);
    await store.close({ guildId: GUILD, ticketId: first.id, closedBy: OPENER, reason: null });

    const second = await reserveSourced();
    await store.attach(GUILD, second.id, OTHER_CHANNEL);

    expect(await store.reopen(GUILD, first.id, OPENER)).toBeNull();
    expect((await stored(first.id)).status).toBe('closed');
  });

  test('bySource skips deleted tickets and other sources', async () => {
    const first = await reserveSourced();
    await store.attach(GUILD, first.id, CHANNEL);

    expect(await store.bySource(GUILD, 'applications', 'app-2')).toBeNull();
    expect(await store.bySource(GUILD, 'giveaways', 'app-1')).toBeNull();

    await store.markDeleted(GUILD, first.id, OPENER, null);
    expect(await store.bySource(GUILD, 'applications', 'app-1')).toBeNull();
  });

  test('a ticket with no source is never linked to one', async () => {
    const plain = await openTicket();

    expect(plain.source).toBeNull();
    expect(plain.ownerId).toBe(OPENER);
  });
});
