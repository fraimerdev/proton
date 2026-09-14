import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RECAP_MAX } from '../src/config.ts';
import { DrizzleAfkStore } from '../src/postgres-store.ts';
import type { RecordPingInput, StartAfkInput } from '../src/store.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleAfkStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

const MEMBER = '100000000000000001';
const OTHER = '100000000000000002';
const AUTHOR = '100000000000000003';

const CHANNEL = '500000000000000001';
const SINCE = new Date('2026-09-13T10:00:00.000Z');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleAfkStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from afk_pings`;
  await handle.client`delete from afk_statuses`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

function input(overrides: Partial<StartAfkInput> = {}): StartAfkInput {
  return {
    guildId: GUILD,
    userId: MEMBER,
    sessionId: '600000000000000001',
    reason: 'lunch',
    since: SINCE,
    previousNick: 'Bob',
    ...overrides,
  };
}

function ping(index: number, overrides: Partial<RecordPingInput> = {}): RecordPingInput {
  return {
    guildId: GUILD,
    userId: MEMBER,
    messageId: `8000000000000000${String(index).padStart(3, '0')}`,
    channelId: CHANNEL,
    authorId: AUTHOR,
    pingedAt: new Date(SINCE.getTime() + index * 1000),
    ...overrides,
  };
}

describe('starting', () => {
  test('stores a new status with nothing applied or ended', async () => {
    const { status, created } = await store.start(input());

    expect(created).toBe(true);
    expect(status).toMatchObject({
      guildId: GUILD,
      userId: MEMBER,
      reason: 'lunch',
      previousNick: 'Bob',
      appliedNick: null,
      endedAt: null,
      endedBy: null,
    });
    expect(status.since.toISOString()).toBe(SINCE.toISOString());
  });

  // A redelivered /afk set carries the same session and must find the first one, not replace it.
  test('a second start for the same member returns the first, untouched', async () => {
    await store.start(input());
    const again = await store.start(input({ sessionId: '600000000000000002', reason: 'dinner' }));

    expect(again.created).toBe(false);
    expect(again.status.sessionId).toBe('600000000000000001');
    expect(again.status.reason).toBe('lunch');
  });

  test('the same member in another server is a separate status', async () => {
    await store.start(input());
    const other = await store.start(
      input({ guildId: OTHER_GUILD, sessionId: '600000000000000002' }),
    );

    expect(other.created).toBe(true);
  });
});

describe('reading', () => {
  test('active leaves out ended statuses and members nobody asked about', async () => {
    await store.start(input());
    await store.start(input({ userId: OTHER, sessionId: '600000000000000002' }));
    await store.markEnded('600000000000000002', 'message:1');

    expect((await store.active(GUILD, [MEMBER, OTHER])).map((status) => status.userId)).toEqual([
      MEMBER,
    ]);
    expect(await store.active(GUILD, [])).toEqual([]);
    expect(await store.all(GUILD)).toHaveLength(2);
    expect(await store.get(GUILD, OTHER)).not.toBeNull();
  });
});

describe('updating', () => {
  test('changes the reason only while the status is active', async () => {
    await store.start(input());

    expect((await store.updateReason(GUILD, MEMBER, null))?.reason).toBeNull();

    await store.markEnded('600000000000000001', 'message:1');
    expect(await store.updateReason(GUILD, MEMBER, 'late')).toBeNull();
  });

  test('records and clears the nickname Proton applied', async () => {
    await store.start(input());

    await store.setAppliedNick('600000000000000001', '[AFK] Bob');
    expect((await store.get(GUILD, MEMBER))?.appliedNick).toBe('[AFK] Bob');

    await store.setAppliedNick('600000000000000001', null);
    expect((await store.get(GUILD, MEMBER))?.appliedNick).toBeNull();
  });

  test('records the tag only while the session is still active, and says whether it did', async () => {
    await store.start(input());

    expect(await store.recordTag('600000000000000001', '[AFK] Bob')).toBe(true);
    expect((await store.get(GUILD, MEMBER))?.appliedNick).toBe('[AFK] Bob');

    await store.markEnded('600000000000000001', 'message:1');

    expect(await store.recordTag('600000000000000001', '[AFK] Robert')).toBe(false);
    expect((await store.get(GUILD, MEMBER))?.appliedNick).toBe('[AFK] Bob');
    expect(await store.recordTag('600000000000000404', '[AFK] Bob')).toBe(false);
  });
});

describe('pings', () => {
  test('records each message once, newest first', async () => {
    await store.start(input());

    expect(await store.recordPing('600000000000000001', ping(1))).toBe(true);
    expect(await store.recordPing('600000000000000001', ping(2))).toBe(true);
    expect(await store.recordPing('600000000000000001', ping(1))).toBe(false);

    expect((await store.pings('600000000000000001')).map((row) => row.messageId)).toEqual([
      ping(2).messageId,
      ping(1).messageId,
    ]);
  });

  test(`keeps only the ${RECAP_MAX} newest`, async () => {
    await store.start(input());

    for (let index = 0; index < RECAP_MAX + 5; index++) {
      await store.recordPing('600000000000000001', ping(index));
    }

    const kept = await store.pings('600000000000000001');
    expect(kept).toHaveLength(RECAP_MAX);
    expect(kept.at(-1)?.messageId).toBe(ping(5).messageId);
  });

  test('records nothing for an ended or unknown session', async () => {
    await store.start(input());
    await store.markEnded('600000000000000001', 'message:1');

    expect(await store.recordPing('600000000000000001', ping(1))).toBe(false);
    expect(await store.recordPing('600000000000000404', ping(2))).toBe(false);
    expect(await store.pings('600000000000000001')).toEqual([]);
  });
});

describe('ending', () => {
  test('the first trigger ends it; the same trigger may run again; any other gets nothing', async () => {
    await store.start(input());

    const first = await store.markEnded('600000000000000001', 'message:1');
    expect(first?.endedBy).toBe('message:1');
    expect(first?.endedAt).not.toBeNull();

    const again = await store.markEnded('600000000000000001', 'message:1');
    expect(again?.endedAt?.toISOString()).toBe(first?.endedAt?.toISOString());

    expect(await store.markEnded('600000000000000001', 'expire:600000000000000001')).toBeNull();
  });

  test('finishing keeps who, since when and how it ended, and forgets the reason, nicknames and pings', async () => {
    await store.start(input());
    await store.start(input({ userId: OTHER, sessionId: '600000000000000002' }));
    await store.recordTag('600000000000000001', '[AFK] Bob');
    await store.recordPing('600000000000000001', ping(1));
    await store.recordPing('600000000000000002', ping(2, { userId: OTHER }));
    const ended = await store.markEnded('600000000000000001', 'message:1');

    await store.finishSession('600000000000000001');

    const kept = await store.get(GUILD, MEMBER);
    expect(kept).toMatchObject({
      guildId: GUILD,
      userId: MEMBER,
      sessionId: '600000000000000001',
      reason: null,
      previousNick: null,
      appliedNick: null,
      endedBy: 'message:1',
    });
    expect(kept?.since.toISOString()).toBe(SINCE.toISOString());
    expect(kept?.endedAt?.toISOString()).toBe(ended?.endedAt?.toISOString());

    expect(await store.pings('600000000000000001')).toEqual([]);
    expect(await store.pings('600000000000000002')).toHaveLength(1);
    expect((await store.get(GUILD, OTHER))?.reason).toBe('lunch');
  });

  test('finishing a session that has not ended leaves its status as it was', async () => {
    await store.start(input());
    await store.recordTag('600000000000000001', '[AFK] Bob');

    await store.finishSession('600000000000000001');

    expect(await store.get(GUILD, MEMBER)).toMatchObject({
      reason: 'lunch',
      previousNick: 'Bob',
      appliedNick: '[AFK] Bob',
      endedAt: null,
    });
  });
});

describe('removing', () => {
  test('remove deletes one session and its pings, and nothing else', async () => {
    await store.start(input());
    await store.start(input({ userId: OTHER, sessionId: '600000000000000002' }));
    await store.recordPing('600000000000000001', ping(1));
    await store.recordPing('600000000000000002', ping(2, { userId: OTHER }));

    await store.remove('600000000000000001');

    expect(await store.get(GUILD, MEMBER)).toBeNull();
    expect(await store.pings('600000000000000001')).toEqual([]);
    expect(await store.pings('600000000000000002')).toHaveLength(1);
  });

  test('removeMember forgets a member who left', async () => {
    await store.start(input());
    await store.recordPing('600000000000000001', ping(1));

    await store.removeMember(GUILD, MEMBER);

    expect(await store.get(GUILD, MEMBER)).toBeNull();
    expect(await store.pings('600000000000000001')).toEqual([]);
  });

  test('deleting the guild row takes its statuses and pings with it', async () => {
    await store.start(input());
    await store.recordPing('600000000000000001', ping(1));

    await handle.client`delete from guilds where id = ${GUILD}`;

    expect(await store.all(GUILD)).toEqual([]);
    expect(await store.pings('600000000000000001')).toEqual([]);
  });
});
