import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { backups, createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { DrizzleBackupStore } from '../src/postgres-store.ts';
import { buildSnapshot, SNAPSHOT_VERSION } from '../src/snapshot.ts';
import { CorruptSnapshotError } from '../src/store.ts';
import {
  fixtureLayout,
  GUILD,
  HIDDEN_CHANNEL,
  harness,
  layout,
  NOW,
  rawChannel,
  rawRole,
  stringOption,
  subcommand,
} from './harness.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleBackupStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleBackupStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.db.delete(backups);
  await handle.db.delete(guilds);
  // `backups.guild_id` is a real foreign key (§6), so the guild has to exist.
  await handle.db.insert(guilds).values({ id: GUILD, name: 'Proton Test Guild' });
});

function snapshotOf(name: 'guildCreate' | 'channelObfuscated') {
  return buildSnapshot(fixtureLayout(name), NOW).snapshot;
}

async function save(id: string, createdAt: Date, snapshot = snapshotOf('guildCreate')) {
  await store.save({
    id,
    guildId: GUILD,
    version: SNAPSHOT_VERSION,
    createdBy: '100000000000000001',
    createdAt,
    snapshot,
  });
}

describe('storing a snapshot in Postgres', () => {
  test('round-trips the document unchanged through jsonb', async () => {
    const snapshot = snapshotOf('channelObfuscated');
    await save('backup-1', new Date(NOW), snapshot);

    const record = await store.get(GUILD, 'backup-1');

    expect(record?.snapshot).toEqual(snapshot);
    expect(record?.version).toBe(SNAPSHOT_VERSION);
    expect(record?.createdAt.getTime()).toBe(NOW);
  });

  test('keeps large permission bitfields exact', async () => {
    // The failure this guards against is silent: a bitfield that survives as a
    // JSON number loses its low bits past 2^53 and the restore quietly grants
    // the wrong permissions.
    const big = String((1n << 51n) | (1n << 44n) | 1n);
    const snapshot = buildSnapshot(
      layout(
        [
          rawChannel({
            permission_overwrites: [{ id: '400000000000000010', type: 0, allow: big, deny: '0' }],
          }),
        ],
        [rawRole({ permissions: big })],
      ),
      NOW,
    ).snapshot;

    await save('backup-big', new Date(NOW), snapshot);
    const record = await store.get(GUILD, 'backup-big');

    expect(record?.snapshot.roles[0]?.permissions).toBe(big);
    expect(record?.snapshot.channels[0]?.overwrites[0]?.allow).toBe(big);
  });

  test('is stored as jsonb, not as a jsonb string', async () => {
    // Drizzle serialises the column itself; a hand-rolled JSON.stringify would
    // double-encode it and `snapshot->>'guildId'` would come back null.
    await save('backup-1', new Date(NOW));

    const rows = (await handle.client`
      select snapshot->>'guildId' as guild_id from backups where id = 'backup-1'
    `) as unknown as Array<{ guild_id: string | null }>;

    expect(rows[0]?.guild_id).toBe(GUILD);
  });

  test('will not hand one guild’s snapshot to another', async () => {
    await handle.db.insert(guilds).values({ id: '900000000000000002', name: 'Elsewhere' });
    await save('backup-1', new Date(NOW));

    expect(await store.get('900000000000000002', 'backup-1')).toBeNull();
  });

  test('refuses to read back a document it cannot validate', async () => {
    // A snapshot read back as an empty object would plan a restore that skips
    // everything and report a healthy-looking "0 channels to recreate".
    await handle.db.insert(backups).values({
      id: 'corrupt',
      guildId: GUILD,
      version: SNAPSHOT_VERSION,
      snapshot: { guildId: GUILD, channels: 'not an array' },
      createdBy: null,
      createdAt: new Date(NOW),
    });

    await expect(store.get(GUILD, 'corrupt')).rejects.toThrow(CorruptSnapshotError);
  });

  test('lists newest first and prunes the rest', async () => {
    await save('oldest', new Date(NOW - 3000));
    await save('middle', new Date(NOW - 2000));
    await save('newest', new Date(NOW - 1000));

    expect((await store.list(GUILD, 10)).map((record) => record.id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);

    expect(await store.prune(GUILD, 2)).toBe(1);
    expect((await store.list(GUILD, 10)).map((record) => record.id)).toEqual(['newest', 'middle']);
    // Idempotent: pruning again deletes nothing.
    expect(await store.prune(GUILD, 2)).toBe(0);
  });

  test('prunes nothing when the guild has no snapshots', async () => {
    expect(await store.prune(GUILD, 5)).toBe(0);
  });

  test('never touches another guild’s snapshots', async () => {
    await handle.db.insert(guilds).values({ id: '900000000000000002', name: 'Elsewhere' });
    await save('mine-old', new Date(NOW - 1000));
    await save('mine-new', new Date(NOW));
    await store.save({
      id: 'theirs',
      guildId: '900000000000000002',
      version: SNAPSHOT_VERSION,
      createdBy: null,
      createdAt: new Date(NOW - 5000),
      snapshot: { ...snapshotOf('guildCreate'), guildId: '900000000000000002' },
    });

    // Keeping one snapshot per guild drops this guild's oldest and nobody
    // else's, however old theirs is.
    expect(await store.prune(GUILD, 1)).toBe(1);

    const survivors = await handle.db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.guildId, '900000000000000002'));
    expect(survivors.map((row) => row.id)).toEqual(['theirs']);
  });
});

/**
 * PLAN.md §12, Gate 2: "Backup snapshot marks obfuscated channels and restore
 * skips them with a report."
 *
 * End to end, against a real database: the recorded gateway fixture goes in
 * through `/backup create`, the row lands in Postgres, and `/backup restore`
 * reads it back and reports.
 */
describe('Gate 2, end to end', () => {
  test('marks the channel it cannot see, and skips it when restoring', async () => {
    const bot = harness({ store, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));

    const created = bot.replyContent() ?? '';
    expect(created).toContain('1 channel could NOT be backed up');
    expect(created).toContain(`<#${HIDDEN_CHANNEL}>`);

    const stored = await store.list(GUILD, 1);
    const hidden = stored[0]?.snapshot.channels.find((channel) => channel.id === HIDDEN_CHANNEL);
    expect(hidden?.obfuscated).toBe(true);
    expect(hidden?.name).toBeNull();

    // Now the server is nuked and the admin asks for it back.
    bot.current.layout = layout([]);
    await bot.run(subcommand('restore', [stringOption('backup_id', stored[0]?.id ?? '')]));

    const restored = bot.replyContent() ?? '';
    expect(restored).toContain('recreate 0 roles and 1 channel');
    expect(restored).toContain('cannot be restored');
    expect(restored).toContain(`<#${HIDDEN_CHANNEL}>`);
    expect(restored).toContain('View Channel');
  });

  test('the permission-failure path: no VIEW_CHANNEL means an empty-looking guild, said out loud', async () => {
    // Every channel obfuscated is what a server that never granted VIEW_CHANNEL
    // actually looks like from 16 Nov 2026. The backup must not read as healthy.
    const blind = layout([
      rawChannel({ id: '500000000000000031', flags: 1 << 17 }),
      rawChannel({ id: '500000000000000032', flags: 1 << 17 }),
    ]);
    const bot = harness({ store, layout: blind });

    await bot.run(subcommand('create'));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('Backed up 0 channels');
    expect(reply).toContain('2 channels could NOT be backed up');
    expect(reply).toContain('View Channel');
    expect(bot.logged('warn', 'could not capture 2 channel(s)')).toBe(true);
  });
});
