import { describe, expect, test } from 'bun:test';
import {
  formatCommandLabel,
  type RawOption,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import type { BackupConfig } from '../src/config.ts';
import { buildSnapshot, type GuildLayout, SNAPSHOT_VERSION } from '../src/snapshot.ts';
import type { BackupRecord } from '../src/store.ts';
import {
  ADMIN,
  APPLICATION,
  booleanOption,
  fixtureLayout,
  GUILD,
  type Harness,
  type HarnessOptions,
  HIDDEN_CHANNEL,
  harness,
  INTERACTION_TOKEN,
  layout,
  MemoryBackupStore,
  NOW,
  type Port,
  payloadOf,
  portFailure,
  rawChannel,
  rawRole,
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
    expect(bot.replyEmbed()?.color).toBe(STATUS_SUCCESS_COLOUR);
    expect(bot.replyEmbed()?.description).toStartWith(STATUS_SUCCESS_EMOJI);
  });

  test('tells the admin at backup time which channels it could not capture', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('1 channel couldn’t be backed up');
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
    expect(bot.replyContent()).toContain('**no** new backup');
    expect(bot.replyContent()).not.toContain('connection refused');
    expect(bot.replyEmbed()?.color).toBe(STATUS_ERROR_COLOUR);
    expect(bot.replyEmbed()?.description).toStartWith(STATUS_ERROR_EMOJI);
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

  test('answers when the module is disabled, rather than failing the interaction', async () => {
    const bot = harness();

    await bot.run(subcommand('create'), { enabled: false });

    expect(bot.replyContent()).toContain('Backup is off in this server');
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

    expect(bot.replyContent()).toContain('to take one before you need it');
  });

  test('shows each snapshot with what it holds and what it missed', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));
    await bot.run(subcommand('list'));

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain(BACKUP_ID);
    expect(reply).toContain('1 channel not captured');
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
    expect(reply).toContain('can’t be restored');
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

    expect(bot.replyContent()).toContain('no snapshot with the ID');
  });

  test('the preview is a prompt, not an outcome, so it stays neutral', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: layout([rawChannel()]) });

    await bot.run(subcommand('create'));

    bot.current.layout = layout([]);
    await bot.run(subcommand('restore', [stringOption('backup_id', BACKUP_ID)]));

    expect(bot.replyData()?.content).toContain('Restore plan for backup');
    expect(bot.replyData()?.embeds).toBeUndefined();
  });

  test('a confirmed restore reports what it recreated', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: layout([rawChannel()]) });

    await bot.run(subcommand('create'));

    bot.current.layout = layout([]);
    await bot.run(
      subcommand('restore', [stringOption('backup_id', BACKUP_ID), booleanOption('confirm', true)]),
    );

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('Restored 0 roles and 1 channel');
    expect(reply).toContain(BACKUP_ID);
    expect(bot.replyEmbed()?.color).toBe(STATUS_SUCCESS_COLOUR);
    expect(bot.replyEmbed()?.description).toStartWith(STATUS_SUCCESS_EMOJI);
  });

  test('a restore that only half landed is red, and names what did not', async () => {
    const store = new MemoryBackupStore();
    const bot = harness({ store, layout: layout([rawChannel()], [rawRole()]) });

    await bot.run(subcommand('create'));

    bot.current.layout = layout([]);
    await bot.run(
      subcommand('restore', [stringOption('backup_id', BACKUP_ID), booleanOption('confirm', true)]),
    );

    const reply = bot.replyContent() ?? '';
    expect(reply).toContain('1 didn’t go through');
    expect(reply).toContain('role Member');
    expect(bot.replyEmbed()?.color).toBe(STATUS_ERROR_COLOUR);
    expect(bot.replyEmbed()?.description).toStartWith(STATUS_ERROR_EMOJI);
  });
});

class UnreadableStore extends MemoryBackupStore {
  override async get(): Promise<BackupRecord | null> {
    throw new Error('connection reset');
  }
}

async function seeded(taken: GuildLayout = layout([rawChannel()])): Promise<MemoryBackupStore> {
  const store = new MemoryBackupStore();
  await store.save({
    id: BACKUP_ID,
    guildId: GUILD,
    version: SNAPSHOT_VERSION,
    createdBy: ADMIN,
    createdAt: new Date(NOW),
    snapshot: buildSnapshot(taken, NOW).snapshot,
  });
  return store;
}

interface Scenario {
  options(): Promise<HarnessOptions>;
  raw: RawOption[];
  config?: Partial<BackupConfig>;
}

const RESTORE = subcommand('restore', [stringOption('backup_id', BACKUP_ID)]);
const CONFIRMED = subcommand('restore', [
  stringOption('backup_id', BACKUP_ID),
  booleanOption('confirm', true),
]);

const SCENARIOS = {
  'a create that saves': { options: async () => ({}), raw: subcommand('create') },
  'a create with the module off': {
    options: async () => ({}),
    raw: subcommand('create'),
    config: { enabled: false },
  },
  'a create with no store wired': {
    options: async () => ({ omit: ['store'] }),
    raw: subcommand('create'),
  },
  'a create with no layout reader wired': {
    options: async () => ({ omit: ['readLayout'] }),
    raw: subcommand('create'),
  },
  'a create before the layout arrives': {
    options: async () => ({ layout: null }),
    raw: subcommand('create'),
  },
  'a create handed another server’s layout': {
    options: async () => ({ layout: { ...layout([rawChannel()]), guildId: '900000000000000002' } }),
    raw: subcommand('create'),
  },
  'a create whose save fails': {
    options: async () => {
      const store = new MemoryBackupStore();
      store.failNextSave = 'connection refused';
      return { store };
    },
    raw: subcommand('create'),
  },
  'a list with nothing in it': { options: async () => ({}), raw: subcommand('list') },
  'a list of snapshots': {
    options: async () => ({ store: await seeded() }),
    raw: subcommand('list'),
  },
  'a list with the module off': {
    options: async () => ({}),
    raw: subcommand('list'),
    config: { enabled: false },
  },
  'a list with no store wired': {
    options: async () => ({ omit: ['store'] }),
    raw: subcommand('list'),
  },
  'a restore with the module off': {
    options: async () => ({}),
    raw: RESTORE,
    config: { enabled: false },
  },
  'a restore with no store wired': {
    options: async () => ({ omit: ['store'] }),
    raw: RESTORE,
  },
  'a restore with no id': { options: async () => ({}), raw: subcommand('restore') },
  'a restore whose store cannot be read': {
    options: async () => ({ store: new UnreadableStore() }),
    raw: RESTORE,
  },
  'a restore of an id this server lacks': { options: async () => ({}), raw: RESTORE },
  'a restore before the layout arrives': {
    options: async () => ({ store: await seeded(), layout: null }),
    raw: RESTORE,
  },
  'a restore the planner refuses': {
    options: async () => ({ store: await seeded(), layout: layout([], [], 'rest') }),
    raw: RESTORE,
  },
  'a restore preview': {
    options: async () => ({ store: await seeded(), layout: layout([]) }),
    raw: RESTORE,
  },
  'a confirmed restore': {
    options: async () => ({ store: await seeded(), layout: layout([]) }),
    raw: CONFIRMED,
  },
  'a confirmed restore that half lands': {
    options: async () => ({
      store: await seeded(layout([rawChannel()], [rawRole()])),
      layout: layout([]),
    }),
    raw: CONFIRMED,
  },
} satisfies Record<string, Scenario>;

async function play(scenario: Scenario, applicationId: string | null): Promise<Harness> {
  const bot = harness({ ...(await scenario.options()), applicationId });
  await bot.run(scenario.raw, scenario.config);
  return bot;
}

describe('/backup acknowledges each interaction exactly once', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(`${name}: a private defer before any read, then the answer as one private followup`, async () => {
      const bot = await play(scenario, APPLICATION);

      const initial = bot.initialCallbacks();
      expect(initial).toHaveLength(1);
      expect(initial[0]?.payload).toMatchObject({ callbackType: 5, ephemeral: true });
      expect(bot.timeline[0]).toBe('interaction_reply:5');

      const followups = bot.followups();
      expect(followups).toHaveLength(1);
      expect(followups[0]?.payload).toMatchObject({
        applicationId: APPLICATION,
        interactionToken: INTERACTION_TOKEN,
        ephemeral: true,
      });
      expect(bot.timeline.at(-1)).toBe('interaction_followup');

      expect(bot.answers()).toHaveLength(1);
      expect((bot.replyData()?.flags ?? 0) & 64).toBe(64);

      const keys = bot.requests.map((request) => request.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    test(`${name}: the followup says exactly what the single reply said`, async () => {
      const deferred = await play(scenario, APPLICATION);
      const direct = await play(scenario, null);

      expect(deferred.replyContent()).not.toBeNull();
      expect(deferred.replyData()).toEqual(direct.replyData());
    });

    test(`${name}: without an application id the one callback is the answer`, async () => {
      const bot = await play(scenario, null);

      const initial = bot.initialCallbacks();
      expect(initial).toHaveLength(1);
      expect(payloadOf(initial[0]).callbackType ?? 4).toBe(4);
      expect(payloadOf(initial[0]).ephemeral).toBe(true);
      expect(bot.followups()).toHaveLength(0);
      expect(bot.timeline).not.toContain('interaction_reply:5');
      expect(bot.answers()).toHaveLength(1);
    });
  }

  test('a create defers before it reads the layout or touches the store', async () => {
    const bot = await play(SCENARIOS['a create that saves'], APPLICATION);

    expect(bot.timeline).toEqual([
      'interaction_reply:5',
      'readLayout',
      'store.save',
      'store.prune',
      'interaction_followup',
    ]);
  });

  test('a list defers before it reads the store', async () => {
    const bot = await play(SCENARIOS['a list of snapshots'], APPLICATION);

    expect(bot.timeline).toEqual(['interaction_reply:5', 'store.list', 'interaction_followup']);
  });

  test('a confirmed restore defers first and reports only once every operation has run', async () => {
    const bot = await play(SCENARIOS['a confirmed restore'], APPLICATION);

    expect(bot.timeline).toEqual([
      'interaction_reply:5',
      'store.get',
      'readLayout',
      'create_channel',
      'interaction_followup',
    ]);
    expect(bot.replyContent()).toContain('Restored 0 roles and 1 channel');
  });

  test('a restore preview still creates nothing, and still asks for confirm: true', async () => {
    const bot = await play(SCENARIOS['a restore preview'], APPLICATION);

    expect(bot.requests.map((request) => request.kind)).toEqual([
      'interaction_reply',
      'interaction_followup',
    ]);
    expect(bot.replyContent()).toContain('confirm: true');
    expect(bot.replyData()?.embeds).toBeUndefined();
  });
});

interface Throwing {
  port: Port;
  options(): Promise<HarnessOptions>;
  raw: RawOption[];
}

const THROWING = {
  'a create whose layout read throws': {
    port: 'readLayout',
    options: async () => ({}),
    raw: subcommand('create'),
  },
  'a create whose prune throws': {
    port: 'store.prune',
    options: async () => ({}),
    raw: subcommand('create'),
  },
  'a list whose store read throws': {
    port: 'store.list',
    options: async () => ({ store: await seeded() }),
    raw: subcommand('list'),
  },
  'a restore whose layout read throws': {
    port: 'readLayout',
    options: async () => ({ store: await seeded() }),
    raw: RESTORE,
  },
  'a confirmed restore whose layout read throws': {
    port: 'readLayout',
    options: async () => ({ store: await seeded() }),
    raw: CONFIRMED,
  },
} satisfies Record<string, Throwing>;

async function crash(
  scenario: Throwing,
  applicationId: string | null,
  extra: HarnessOptions = {},
): Promise<Harness> {
  const bot = harness({
    ...(await scenario.options()),
    failing: [scenario.port],
    applicationId,
    ...extra,
  });
  await expect(bot.run(scenario.raw)).rejects.toThrow(portFailure(scenario.port));
  return bot;
}

function callbacksSent(bot: Harness) {
  return bot.restCalls.filter((call) => call.path.startsWith('/interactions/'));
}

describe('/backup when a port throws after the defer', () => {
  for (const [name, scenario] of Object.entries(THROWING)) {
    test(`${name}: rethrows after the private defer and leaves the apology to the worker`, async () => {
      const bot = await crash(scenario, APPLICATION);

      const initial = bot.initialCallbacks();
      expect(initial).toHaveLength(1);
      expect(initial[0]?.payload).toMatchObject({ callbackType: 5, ephemeral: true });

      expect(bot.followups()).toHaveLength(0);
      expect(callbacksSent(bot)).toHaveLength(1);
      expect(bot.answers()).toHaveLength(0);
    });

    test(`${name}: without an application id it rethrows before sending anything`, async () => {
      const bot = await crash(scenario, null);

      expect(bot.requests).toHaveLength(0);
      expect(bot.restCalls).toHaveLength(0);
    });
  }

  test('a redelivery after the throw defers once and delivers the real answer once', async () => {
    const bot = await crash(THROWING['a create whose layout read throws'], APPLICATION, {
      eventId: 'event-redelivered',
    });

    bot.current.failing.clear();
    await bot.run(subcommand('create'));

    expect(callbacksSent(bot)).toHaveLength(1);
    expect(bot.answers()).toHaveLength(1);
    expect(bot.replyContent()).toContain('Backed up 1 channel and 2 roles.');
  });

  test('a redelivery that throws again does not defer a second time', async () => {
    const scenario = THROWING['a create whose layout read throws'];
    const bot = await crash(scenario, APPLICATION, { eventId: 'event-redelivered' });

    await expect(bot.run(scenario.raw)).rejects.toThrow(portFailure(scenario.port));

    expect(callbacksSent(bot)).toHaveLength(1);
    expect(bot.answers()).toHaveLength(0);
  });
});

const RENAMED = (key: string, path?: string) =>
  formatCommandLabel(key, path, key === 'backup' ? 'snap' : undefined);

describe('/backup names its commands the way this server shows them', () => {
  test('an empty list points at the renamed create', async () => {
    const bot = harness({ commandLabel: RENAMED });

    await bot.run(subcommand('list'));

    expect(bot.replyContent()).toContain('Run `/snap create` to take one');
    expect(bot.replyContent()).not.toContain('/backup');
  });

  test('a restore of an unknown id points at the renamed list', async () => {
    const bot = harness({ commandLabel: RENAMED });

    await bot.run(RESTORE);

    expect(bot.replyContent()).toContain('Run `/snap list` to see the ones it has.');
  });

  test('a restore with no id points at the renamed list', async () => {
    const bot = harness({ commandLabel: RENAMED });

    await bot.run(subcommand('restore'));

    expect(bot.replyContent()).toContain('I need a snapshot ID. Run `/snap list`');
  });

  test('a create that missed a hidden channel points at the renamed create', async () => {
    const bot = harness({ commandLabel: RENAMED, layout: fixtureLayout('channelObfuscated') });

    await bot.run(subcommand('create'));

    expect(bot.replyContent()).toContain('then run `/snap create` again.');
  });

  test('without a label source the copy names /backup as it always has', async () => {
    const empty = harness();
    await empty.run(subcommand('list'));
    expect(empty.replyContent()).toContain(
      'This server has no snapshots. Run `/backup create` to take one before you need it.',
    );

    const unknown = harness();
    await unknown.run(RESTORE);
    expect(unknown.replyContent()).toContain(
      `This server has no snapshot with the ID \`${BACKUP_ID}\`. Run \`/backup list\` to see the ` +
        'ones it has.',
    );

    const hidden = harness({ layout: fixtureLayout('channelObfuscated') });
    await hidden.run(subcommand('create'));
    expect(hidden.replyContent()).toContain(
      '(Channel Settings → Permissions), then run `/backup create` again. Until then, restoring ' +
        'this snapshot leaves that channel untouched',
    );
  });
});
