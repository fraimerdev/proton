import { describe, expect, test } from 'bun:test';
import { SNAPSHOT_VERSION } from '../src/snapshot.ts';
import {
  ADMIN,
  fixtureLayout,
  GUILD,
  HIDDEN_CHANNEL,
  harness,
  layout,
  MemoryBackupStore,
  NOW,
  rawChannel,
  stringOption,
  subcommand,
} from './harness.ts';

const BACKUP_ID = '01JBACKUP00000000000000001';

describe('/backup create', () => {
  test('saves a snapshot and says what it captured', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store });

    await bot.run(subcommand('create'));

    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.id).toBe(BACKUP_ID);
    expect(store.records[0]?.guildId).toBe(GUILD);
    expect(store.records[0]?.version).toBe(SNAPSHOT_VERSION);
    expect(store.records[0]?.createdBy).toBe(ADMIN);
    expect(store.records[0]?.createdAt.getTime()).toBe(NOW);
    expect(bot.replyContent()).toContain('Backed up 1 channel and 2 roles.');
  });

  test('tells the admin at backup time which channels it could not capture', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('1 channel could NOT be backed up');
    expect(reply).toContain(`<#${HIDDEN_CHANNEL}>`);
    expect(reply).toContain('View Channel');

    const hidden = store.records[0]?.snapshot.channels.find((c) => c.id === HIDDEN_CHANNEL);
    expect(hidden?.obfuscated).toBe(true);
    expect(hidden?.name).toBeNull();
  });

  test('logs the gap too, because the reply is ephemeral and seen once', async () => {
    const bot = harness({ layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));

    expect(bot.logged('warn', 'could not capture 1 channel')).toBe(true);
    expect(bot.logged('warn', HIDDEN_CHANNEL)).toBe(true);
  });

  test('prunes to the number of snapshots the guild keeps', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store });

    for (const id of ['a', 'b', 'c']) {
      await store.save({
        id,
        guildId: GUILD,
        version: SNAPSHOT_VERSION,
        createdBy: null,
        createdAt: new Date(NOW - 1000),
        snapshot: {
          schemaVersion: SNAPSHOT_VERSION,
          guildId: GUILD,
          capturedAt: NOW - 1000,
          source: 'gateway',
          channels: [],
          roles: [],
        },
      });
    }

    await bot.run(subcommand('create'), { retainBackups: 2 });

    expect(store.records).toHaveLength(2);

    expect(store.records.map((record) => record.id)).toContain(BACKUP_ID);
    expect(bot.replyContent()).toContain('Deleted 2 older snapshots');
  });

  test('reports a failed write instead of claiming a backup exists', async () => {
    const store = new MemoryBackupStore();
    store.failNextSave = 'connection refused';
    const bot = harness({ store });

    await bot.run(subcommand('create'));

    expect(store.records).toHaveLength(0);
    expect(bot.replyContent()).toContain('NO new backup');
    expect(bot.replyContent()).not.toContain('connection refused');
    expect(bot.logged('error', 'could not be saved')).toBe(true);
  });

  test('refuses a layout that belongs to another server', async () => {
    const elsewhere = { ...layout([rawChannel()]), guildId: '900000000000000002' };
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: elsewhere });

    await bot.run(subcommand('create'));

    expect(store.records).toHaveLength(0);
    expect(bot.replyContent()).toContain('stopped rather than save something wrong');
  });

  test('says so when the gateway has not sent the guild yet', async () => {
    const bot = harness({ layout: null });

    await bot.run(subcommand('create'));

    expect(bot.replyContent()).toContain('channel and role list yet');
  });

  test('answers when the module is switched off, rather than failing the interaction', async () => {
    const bot = harness();

    await bot.run(subcommand('create'), { enabled: false });

    expect(bot.replyContent()).toContain('switched off in this server');
  });

  test('tells the admin nothing was saved, and leaves the wiring detail in the log', async () => {
    const bot = harness({ omit: ['store'] });

    await bot.run(subcommand('create'));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('Nothing was saved');
    expect(reply).not.toContain('DrizzleBackupStore');
    expect(bot.logged('error', 'createBackupModule')).toBe(true);
  });
});

describe('/backup list', () => {
  test('says how to take one when there are none', async () => {
    const bot = harness();

    await bot.run(subcommand('list'));

    expect(bot.replyContent()).toContain('take it before you need it');
  });

  test('shows each snapshot with what it holds and what it missed', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));
    await bot.run(subcommand('list'));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain(BACKUP_ID);
    expect(reply).toContain('1 channel NOT captured');
  });
});

describe('/backup restore', () => {
  test('previews the plan and skips what it cannot recreate', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));

    bot.current.layout = layout([]);
    await bot.run(subcommand('restore', [stringOption('backup_id', BACKUP_ID)]));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('recreate 0 roles and 1 channel');
    expect(reply).toContain('cannot be restored');
    expect(reply).toContain(`<#${HIDDEN_CHANNEL}>`);

    expect(reply).toContain('confirm: true');
  });

  test('does not leak another server’s snapshot to an id-guesser', async () => {
    const store = new MemoryBackupStore();
    await store.save({
      id: 'someone-elses',
      guildId: '900000000000000002',
      version: SNAPSHOT_VERSION,
      createdBy: null,
      createdAt: new Date(NOW),
      snapshot: {
        schemaVersion: SNAPSHOT_VERSION,
        guildId: '900000000000000002',
        capturedAt: NOW,
        source: 'gateway',
        channels: [],
        roles: [],
      },
    });
    const bot = harness({ store });

    await bot.run(subcommand('restore', [stringOption('backup_id', 'someone-elses')]));

    expect(bot.replyContent()).toContain('no snapshot with the id');
  });
});
