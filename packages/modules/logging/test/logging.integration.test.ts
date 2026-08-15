import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMessageLogListener } from '../src/listeners.ts';
import { runMessageLogMaintenance } from '../src/maintenance.ts';
import { partitionName } from '../src/partitions.ts';
import { PostgresMessageLogStore } from '../src/postgres-store.ts';
import type { MessageLogEntry } from '../src/store.ts';
import { messageLogs } from '../src/table.ts';
import {
  AUTHOR,
  CHANNEL,
  context,
  GUILD,
  MESSAGE,
  messageBulkDeleted,
  messageDeleted,
  messageUpdated,
} from './harness.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: PostgresMessageLogStore;

const NOW = new Date('2026-08-14T00:10:00Z');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new PostgresMessageLogStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await store.dropPartitions(await store.listPartitions());
});

function entry(overrides: Partial<MessageLogEntry> = {}): MessageLogEntry {
  return {
    id: `message.deleted:${MESSAGE}`,
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    authorId: AUTHOR,
    kind: 'delete',
    contentBefore: null,
    contentAfter: null,
    occurredAt: new Date('2026-08-14T13:45:12.000Z'),
    ...overrides,
  };
}

type CountRow = { n: number };
type ClassRow = { relkind: string; def: string };
type IndexRow = { indexname: string };

async function countIn(partition: string): Promise<number> {
  const rows = (await handle.client.unsafe(
    `select count(*)::int as n from "${partition}"`,
  )) as unknown as CountRow[];
  return rows[0]?.n ?? 0;
}

describe('the message_logs migration', () => {
  test('creates a table partitioned by the day a log entry happened', async () => {
    const rows = await handle.client<ClassRow[]>`
      select relkind, pg_get_partkeydef(oid) as def
        from pg_class where relname = 'message_logs'
    `;

    expect(rows[0]?.relkind).toBe('p');
    expect(rows[0]?.def).toBe('RANGE (occurred_at)');
  });

  test('gives new partitions the parent’s indexes without being asked', async () => {
    await store.ensurePartition(NOW);

    const indexes = await handle.client<IndexRow[]>`
      select indexname from pg_indexes where tablename = ${partitionName(NOW)}
    `;

    expect(indexes.length).toBeGreaterThanOrEqual(3);
  });
});

describe('per-guild opt-in', () => {
  test('a guild that has not opted in stores nothing', async () => {
    const listener = createMessageLogListener({ store });

    await listener.handler(messageUpdated(), context());
    await listener.handler(messageDeleted(), context());

    expect(await store.listPartitions()).toEqual([]);
  });

  test('a guild that opts in has its edits recorded, content and all', async () => {
    const listener = createMessageLogListener({ store });

    await listener.handler(messageUpdated(), context({ enabled: true }));

    const rows = await handle.db.select().from(messageLogs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: MESSAGE,
      authorId: AUTHOR,
      kind: 'edit',
      contentAfter: 'the edited text',
    });
  });

  test('the row lands in the partition for the day it happened', async () => {
    const listener = createMessageLogListener({ store });

    await listener.handler(messageUpdated(), context({ enabled: true }));

    expect(await countIn('message_logs_2026_08_14')).toBe(1);
  });

  test('a bulk delete becomes one row per message', async () => {
    const listener = createMessageLogListener({ store });
    const ids = ['600000000000000010', '600000000000000011', '600000000000000012'];

    await listener.handler(messageBulkDeleted(ids), context({ enabled: true }));

    const rows = await handle.db.select().from(messageLogs);
    expect(rows.map((row) => row.messageId).sort()).toEqual(ids);
  });

  test('ignores a channel on the ignore list', async () => {
    const listener = createMessageLogListener({ store });

    await listener.handler(
      messageUpdated(),
      context({ enabled: true, ignoredChannels: [CHANNEL] }),
    );

    expect(await store.listPartitions()).toEqual([]);
  });
});

describe('writes', () => {
  test('a redelivered event is written once (I4)', async () => {
    const listener = createMessageLogListener({ store });
    const ctx = context({ enabled: true });

    await listener.handler(messageUpdated(), ctx);
    await listener.handler(messageUpdated(), ctx);

    const rows = await handle.db.select().from(messageLogs);
    expect(rows).toHaveLength(1);
  });

  test('create the day’s partition rather than losing the log', async () => {
    expect(await store.listPartitions()).toEqual([]);

    const written = await store.append([entry()]);

    expect(written).toBe(1);
    expect(await store.listPartitions()).toEqual(['message_logs_2026_08_14']);
  });

  test('report how many rows were new, so a dedupe is distinguishable from a write', async () => {
    expect(await store.append([entry()])).toBe(1);
    expect(await store.append([entry()])).toBe(0);
  });

  test('span partitions in a single batch', async () => {
    const written = await store.append([
      entry({ id: 'a', occurredAt: new Date('2026-08-14T23:59:59.999Z') }),
      entry({ id: 'b', occurredAt: new Date('2026-08-15T00:00:00.000Z') }),
    ]);

    expect(written).toBe(2);
    expect(await countIn('message_logs_2026_08_14')).toBe(1);
    expect(await countIn('message_logs_2026_08_15')).toBe(1);
  });
});

describe('retention', () => {
  async function stockThirtyFiveDays(): Promise<void> {
    for (let offset = 34; offset >= 0; offset--) {
      const day = new Date(NOW.getTime() - offset * 86_400_000);
      await store.ensurePartition(day);
      await store.append([
        entry({
          id: `day-${offset}`,
          occurredAt: new Date(
            Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12),
          ),
        }),
      ]);
    }
  }

  test('the job creates tomorrow’s partition before it is needed', async () => {
    const result = await runMessageLogMaintenance(store, { now: NOW });

    expect(result.ensured).toEqual(['message_logs_2026_08_14', 'message_logs_2026_08_15']);
    expect(await store.listPartitions()).toEqual([
      'message_logs_2026_08_14',
      'message_logs_2026_08_15',
    ]);
  });

  test('the job drops the partitions past retention and keeps the rest', async () => {
    await stockThirtyFiveDays();
    expect(await store.listPartitions()).toHaveLength(35);

    const result = await runMessageLogMaintenance(store, { now: NOW, retentionDays: 30 });

    expect(result.dropped).toEqual([
      'message_logs_2026_07_11',
      'message_logs_2026_07_12',
      'message_logs_2026_07_13',
      'message_logs_2026_07_14',
      'message_logs_2026_07_15',
    ]);

    const remaining = await store.listPartitions();

    expect(remaining).toHaveLength(31);
    expect(remaining).toContain('message_logs_2026_07_16');
    expect(remaining).not.toContain('message_logs_2026_07_15');
  });

  test('dropping a partition takes its content with it and leaves the rest intact', async () => {
    await stockThirtyFiveDays();

    await runMessageLogMaintenance(store, { now: NOW, retentionDays: 30 });

    const rows = await handle.db.select().from(messageLogs);

    expect(rows).toHaveLength(30);
    expect(await countIn('message_logs_2026_07_16')).toBe(1);
    expect(await countIn('message_logs_2026_08_14')).toBe(1);
  });

  test('refuses to drop a table that is not one of its partitions', async () => {
    await expect(store.dropPartitions(['cases'])).rejects.toThrow('refusing to drop');

    const rows = await handle.client<CountRow[]>`
      select count(*)::int as n from pg_class where relname = 'cases'
    `;
    expect(rows[0]?.n).toBe(1);
  });
});
