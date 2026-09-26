import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cases, createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  DrizzleCaseLedger,
  DrizzleCaseMessageStore,
  DrizzleTimeoutStore,
} from '../src/punish/postgres-store.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let timeouts: DrizzleTimeoutStore;
let ledger: DrizzleCaseLedger;
let messages: DrizzleCaseMessageStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const MEMBER = '400000000000000001';
const OTHER = '400000000000000002';
const MODERATOR = '100000000000000001';
const CHANNEL = '500000000000000001';
const NOW = new Date('2026-09-18T12:00:00.000Z');

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  timeouts = new DrizzleTimeoutStore(handle);
  ledger = new DrizzleCaseLedger(handle);
  messages = new DrizzleCaseMessageStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

let caseNumber = 0;

async function seedCase(input: {
  id: string;
  type: string;
  targetId?: string;
  guildId?: string;
  createdAt?: Date;
  revertedAt?: Date;
  dryRun?: boolean;
  idempotencyKey?: string;
}): Promise<void> {
  caseNumber += 1;
  await handle.db.insert(cases).values({
    id: input.id,
    guildId: input.guildId ?? GUILD,
    caseNumber,
    type: input.type,
    actorId: MODERATOR,
    targetId: input.targetId ?? MEMBER,
    moduleId: 'moderation',
    idempotencyKey: input.idempotencyKey ?? `key:${input.id}`,
    dryRun: input.dryRun ?? false,
    createdAt: input.createdAt ?? NOW,
    ...(input.revertedAt ? { revertedAt: input.revertedAt, revertedBy: MODERATOR } : {}),
  });
}

function timeout(caseId: string, userId: string, endsInMinutes: number) {
  return {
    caseId,
    guildId: GUILD,
    userId,
    startedAt: NOW,
    endsAt: at(endsInMinutes),
    appliedUntil: at(endsInMinutes),
  };
}

describe('DrizzleTimeoutStore', () => {
  test('records a timeout once and lists the open ones by end', async () => {
    expect(await timeouts.record(timeout('caseA', MEMBER, 120))).toBe(true);
    expect(await timeouts.record(timeout('caseA', MEMBER, 120))).toBe(false);
    await timeouts.record(timeout('caseB', MEMBER, 30));
    await timeouts.record(timeout('caseC', OTHER, 60));

    const open = await timeouts.open(GUILD, MEMBER);

    expect(open.map((row) => row.caseId)).toEqual(['caseB', 'caseA']);
    expect(open[0]).toMatchObject({
      guildId: GUILD,
      userId: MEMBER,
      endsAt: at(30).getTime(),
      appliedUntil: at(30).getTime(),
      closedAt: null,
      closeReason: null,
    });
    expect((await timeouts.openUsers(GUILD)).sort()).toEqual([MEMBER, OTHER].sort());
  });

  test('closeOpen supersedes every open row but the one it keeps, once', async () => {
    await timeouts.record(timeout('caseA', MEMBER, 120));
    await timeouts.record(timeout('caseB', MEMBER, 30));

    const closed = await timeouts.closeOpen(
      GUILD,
      MEMBER,
      { at: NOW, by: MODERATOR, reason: 'superseded' },
      { except: 'caseB' },
    );
    const again = await timeouts.closeOpen(
      GUILD,
      MEMBER,
      { at: NOW, by: MODERATOR, reason: 'superseded' },
      { except: 'caseB' },
    );

    expect(closed.map((row) => [row.caseId, row.closeReason, row.closedBy])).toEqual([
      ['caseA', 'superseded', MODERATOR],
    ]);
    expect(again).toEqual([]);
    expect((await timeouts.open(GUILD, MEMBER)).map((row) => row.caseId)).toEqual(['caseB']);
  });

  test('close touches only the named rows that are still open', async () => {
    await timeouts.record(timeout('caseA', MEMBER, 1));
    await timeouts.record(timeout('caseB', MEMBER, 2));

    const first = await timeouts.close(GUILD, ['caseA'], { at: NOW, by: null, reason: 'expired' });
    const second = await timeouts.close(GUILD, ['caseA', 'caseB'], {
      at: NOW,
      by: null,
      reason: 'expired',
    });

    expect(first.map((row) => row.caseId)).toEqual(['caseA']);
    expect(second.map((row) => row.caseId)).toEqual(['caseB']);
    expect(await timeouts.close(GUILD, [], { at: NOW, by: null, reason: 'expired' })).toEqual([]);
  });

  test('applied_until moves on open rows only, and the expiry is logged exactly once', async () => {
    await timeouts.record(timeout('caseA', MEMBER, 120));
    await timeouts.record(timeout('caseB', MEMBER, 30));
    await timeouts.close(GUILD, ['caseB'], { at: NOW, by: null, reason: 'expired' });

    await timeouts.setAppliedUntil(GUILD, MEMBER, at(500));

    const [open] = await timeouts.open(GUILD, MEMBER);
    expect(open?.appliedUntil).toBe(at(500).getTime());

    expect(await timeouts.markExpiryLogged(GUILD, 'caseB', NOW)).toBe(true);
    expect(await timeouts.markExpiryLogged(GUILD, 'caseB', NOW)).toBe(false);
    expect(await timeouts.markExpiryLogged(OTHER_GUILD, 'caseA', NOW)).toBe(false);
  });

  test('trackedCaseIds lists every row of the member, open or closed', async () => {
    await timeouts.record(timeout('caseA', MEMBER, 120));
    await timeouts.record(timeout('caseB', MEMBER, 30));
    await timeouts.record(timeout('caseC', OTHER, 30));
    await timeouts.close(GUILD, ['caseB'], { at: NOW, by: null, reason: 'expired' });

    expect((await timeouts.trackedCaseIds(GUILD, MEMBER)).sort()).toEqual(['caseA', 'caseB']);
    expect(await timeouts.trackedCaseIds(OTHER_GUILD, MEMBER)).toEqual([]);
  });
});

describe('DrizzleCaseLedger', () => {
  test('recent finds the newest unreverted real case of the kind inside the window', async () => {
    await seedCase({ id: 'old', type: 'timeout', createdAt: at(-30) });
    await seedCase({ id: 'reverted', type: 'timeout', createdAt: at(-2), revertedAt: at(-1) });
    await seedCase({ id: 'rehearsal', type: 'timeout', createdAt: at(-1), dryRun: true });
    await seedCase({ id: 'warned', type: 'warn', createdAt: at(-1) });
    await seedCase({ id: 'fresh', type: 'timeout', createdAt: at(-3) });

    expect((await ledger.recent(GUILD, MEMBER, 'timeout', at(-10)))?.caseId).toBe('fresh');
    expect(await ledger.recent(GUILD, OTHER, 'timeout', at(-10))).toBeNull();
    expect(await ledger.recent(OTHER_GUILD, MEMBER, 'timeout', at(-10))).toBeNull();
  });

  test('closeOpen stamps only open cases of the kind for the target, optionally by id', async () => {
    await seedCase({ id: 'ban1', type: 'ban', idempotencyKey: 'evt-1:action' });
    await seedCase({ id: 'ban2', type: 'ban', revertedAt: at(-5) });
    await seedCase({ id: 'ban3', type: 'ban', targetId: OTHER });
    await seedCase({ id: 'warn1', type: 'warn' });
    await seedCase({ id: 'warn2', type: 'warn' });

    const bans = await ledger.closeOpen(
      GUILD,
      { targetId: MEMBER, kind: 'ban' },
      { at: NOW, by: MODERATOR },
    );
    const warn = await ledger.closeOpen(
      GUILD,
      { targetId: MEMBER, kind: 'warn', caseIds: ['warn2'] },
      { at: NOW, by: MODERATOR },
    );
    const none = await ledger.closeOpen(
      GUILD,
      { targetId: MEMBER, kind: 'warn', caseIds: [] },
      { at: NOW, by: MODERATOR },
    );

    expect(bans.map((entry) => [entry.caseId, entry.idempotencyKey])).toEqual([
      ['ban1', 'evt-1:action'],
    ]);
    expect(bans[0]?.revertedAt).toBe(NOW.getTime());
    expect(warn.map((entry) => entry.caseId)).toEqual(['warn2']);
    expect(none).toEqual([]);
    expect((await ledger.find(GUILD, 'warn1'))?.revertedAt).toBeNull();
  });

  test('closeOpen can leave named cases alone and skip cases older than a date', async () => {
    await seedCase({ id: 'new1', type: 'ban' });
    await seedCase({ id: 'old1', type: 'ban' });
    await seedCase({ id: 'tmo1', type: 'timeout', createdAt: at(-60 * 24 * 60) });
    await seedCase({ id: 'tmo2', type: 'timeout', createdAt: at(-60) });
    await seedCase({ id: 'tmo3', type: 'timeout', createdAt: at(-30) });

    const superseded = await ledger.closeOpen(
      GUILD,
      { targetId: MEMBER, kind: 'ban', exceptCaseIds: ['new1'] },
      { at: NOW, by: MODERATOR },
    );
    const recent = await ledger.closeOpen(
      GUILD,
      {
        targetId: MEMBER,
        kind: 'timeout',
        exceptCaseIds: ['tmo3'],
        createdAfter: at(-28 * 24 * 60),
      },
      { at: NOW, by: MODERATOR },
    );
    const emptyExcept = await ledger.closeOpen(
      GUILD,
      { targetId: MEMBER, kind: 'timeout', exceptCaseIds: [] },
      { at: NOW, by: MODERATOR },
    );

    expect(superseded.map((entry) => entry.caseId)).toEqual(['old1']);
    expect(recent.map((entry) => entry.caseId)).toEqual(['tmo2']);
    expect(emptyExcept.map((entry) => entry.caseId).sort()).toEqual(['tmo1', 'tmo3']);
  });

  test('byIdempotencyKey, find, counts and the last case read the guild’s own rows', async () => {
    await seedCase({
      id: 'caseA',
      type: 'warn',
      createdAt: at(-3),
      idempotencyKey: 'evt-1:action',
    });
    await seedCase({ id: 'caseB', type: 'warn', createdAt: at(-2) });
    await seedCase({ id: 'caseC', type: 'ban', createdAt: at(-1) });
    await seedCase({ id: 'caseD', type: 'ban', createdAt: at(0), dryRun: true });
    await seedCase({ id: 'caseE', type: 'kick', guildId: OTHER_GUILD });

    expect(await ledger.byIdempotencyKey(GUILD, 'evt-1:action')).toEqual({
      caseId: 'caseA',
      kind: 'warn',
      revertedAt: null,
    });
    expect(await ledger.byIdempotencyKey(OTHER_GUILD, 'evt-1:action')).toBeNull();
    expect((await ledger.find(GUILD, 'caseC'))?.kind).toBe('ban');
    expect(await ledger.find(GUILD, 'caseE')).toBeNull();
    expect(await ledger.countsForTarget(GUILD, MEMBER)).toEqual({ warn: 2, ban: 1 });
    expect((await ledger.lastCase(GUILD, MEMBER))?.caseId).toBe('caseC');
  });
});

describe('DrizzleCaseMessageStore', () => {
  const attachment = {
    id: '1500000000000000001',
    filename: 'proof.png',
    contentType: 'image/png',
    size: 1024,
    url: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
    expiresAt: 1_800_000_000_000,
  };

  function row(messageId: string, minutes: number, proof = false) {
    return {
      caseId: 'caseA',
      guildId: GUILD,
      messageId,
      channelId: CHANNEL,
      authorId: MEMBER,
      content: `message ${messageId}`,
      attachments: proof ? [attachment] : [],
      createdAt: at(minutes).getTime(),
      deletedAt: null,
      proof,
      expiresAt: at(30 * 24 * 60).getTime(),
    };
  }

  test('saves each message once per case and reads them back in order', async () => {
    const saved = await messages.save([
      row('1400000000000000002', -2),
      row('1400000000000000001', -5, true),
    ]);
    const again = await messages.save([row('1400000000000000001', -5, true)]);

    expect(saved).toBe(2);
    expect(again).toBe(0);

    const stored = await messages.forCase(GUILD, 'caseA');
    expect(stored.map((entry) => [entry.messageId, entry.proof])).toEqual([
      ['1400000000000000001', true],
      ['1400000000000000002', false],
    ]);
    expect(stored[0]?.attachments).toEqual([attachment]);
    expect(await messages.forCase(OTHER_GUILD, 'caseA')).toEqual([]);
  });

  test('purges what has expired and keeps the rest', async () => {
    await messages.save([
      { ...row('1400000000000000001', -5), expiresAt: at(-1).getTime() },
      row('1400000000000000002', -2),
    ]);

    expect(await messages.purgeExpired(NOW)).toBe(1);
    expect((await messages.forCase(GUILD, 'caseA')).map((entry) => entry.messageId)).toEqual([
      '1400000000000000002',
    ]);
  });
});
