import { describe, expect, test } from 'bun:test';
import type { GuildState, GuildStatePatch, GuildStateStore } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { type GuildRegistrar, GuildStateConsumer } from '../src/guild-state-consumer.ts';

const PUBLIC_THREAD = 11;

const BOT = '1200000000000000001';
const GUILD = '900000000000000001';
const PARENT = '500000000000000001';
const CATEGORY = '500000000000000009';
const CHANNEL = '500000000000000021';
const THREAD = '600000000000000001';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const registrar: GuildRegistrar = {
  ensure: async () => {},
  markLeft: async () => {},
};

function memoryStore(seed: GuildState | null = emptyState()) {
  const states = new Map<string, GuildState>();
  if (seed) states.set(seed.guildId, seed);

  const store: GuildStateStore = {
    get: async (id) => states.get(id) ?? null,
    put: async (value) => {
      states.set(value.guildId, value);
    },
    patch: async (id, patch: GuildStatePatch) => {
      const held = states.get(id);
      if (!held) return;

      if (patch.kind === 'channel.upsert') held.channels.set(patch.channel.id, patch.channel);
      if (patch.kind === 'channel.delete') held.channels.delete(patch.channelId);
    },
    delete: async (id) => {
      states.delete(id);
    },
  };

  return { store, states };
}

function emptyState(): GuildState {
  return {
    guildId: GUILD,
    ownerId: '200000000000000001',
    everyoneRoleId: GUILD,
    roles: new Map(),
    botRoleIds: [],
    channels: new Map(),
    updatedAt: Date.now(),
  };
}

function consumer(store: GuildStateStore) {
  return new GuildStateConsumer({
    bus: { publish: async () => {}, subscribe: () => ({ group: 'x', close: async () => {} }) },
    store,
    registrar,
    botUserId: BOT,
    logger: silent,
  });
}

function events(fixture: Parameters<typeof dispatch>[0]) {
  const event = normalise(dispatch(fixture))[0];
  if (!event) throw new Error(`fixture ${String(fixture)} did not normalise`);
  return event;
}

describe('a channel created after the bot joined', () => {
  test('enters guild state, instead of waiting for the next GUILD_CREATE to appear', async () => {
    const { store, states } = memoryStore();

    await consumer(store).handle(events('channelCreate'));

    expect(states.get(GUILD)?.channels.has(CHANNEL)).toBe(true);
  });

  test('brings its category with it, so category overwrites can be inherited', async () => {
    const { store, states } = memoryStore();

    await consumer(store).handle(events('channelCreate'));

    expect(states.get(GUILD)?.channels.get(CHANNEL)?.parentId).toBe(CATEGORY);
  });

  test('is refreshed on CHANNEL_UPDATE, which is when overwrites actually change', async () => {
    const { store, states } = memoryStore();
    const c = consumer(store);

    await c.handle(events('channelCreate'));
    await c.handle(events('channelUpdate'));

    expect(states.get(GUILD)?.channels.get(CHANNEL)?.parentId).toBe(CATEGORY);
    expect(states.get(GUILD)?.channels.size).toBe(1);
  });

  test('leaves guild state when it is deleted, so a stale id stops answering', async () => {
    const { store, states } = memoryStore();
    const c = consumer(store);

    await c.handle(events('channelCreate'));
    await c.handle(events('channelDelete'));

    expect(states.get(GUILD)?.channels.has(CHANNEL)).toBe(false);
  });
});

describe('a thread created at runtime', () => {
  test('enters guild state, which is what a permission check in it needs', async () => {
    const { store, states } = memoryStore();

    await consumer(store).handle(events('threadCreate'));

    expect(states.get(GUILD)?.channels.has(THREAD)).toBe(true);
  });

  test('records the parent channel that holds the only overwrites governing it', async () => {
    const { store, states } = memoryStore();

    await consumer(store).handle(events('threadCreate'));

    expect(states.get(GUILD)?.channels.get(THREAD)?.parentId).toBe(PARENT);
  });

  test('is recorded with its thread type, not as a plain channel with overwrites of its own', async () => {
    const { store, states } = memoryStore();

    await consumer(store).handle(events('threadCreate'));

    const stored = states.get(GUILD)?.channels.get(THREAD);
    expect(stored?.type).toBe(PUBLIC_THREAD);
    expect(stored?.overwrites).toEqual([]);
  });

  test('survives THREAD_UPDATE, because archiving a thread does not unresolve it', async () => {
    const { store, states } = memoryStore();
    const c = consumer(store);

    await c.handle(events('threadCreate'));
    await c.handle(events('threadUpdate'));

    expect(states.get(GUILD)?.channels.get(THREAD)?.parentId).toBe(PARENT);
  });

  test('leaves guild state on THREAD_DELETE, whose payload is only id, guild, parent and type', async () => {
    const { store, states } = memoryStore();
    const c = consumer(store);

    await c.handle(events('threadCreate'));
    await c.handle(events('threadDelete'));

    expect(states.get(GUILD)?.channels.has(THREAD)).toBe(false);
  });

  test('is stored once when the gateway redelivers the same create on RESUME', async () => {
    const { store, states } = memoryStore();
    const c = consumer(store);

    await c.handle(events('threadCreate'));
    await c.handle(events('threadCreate'));

    expect(states.get(GUILD)?.channels.size).toBe(1);
  });
});

describe('lifecycle events the consumer cannot act on', () => {
  test('a create for a guild with no cached state is dropped, not half-applied', async () => {
    const { store, states } = memoryStore(null);

    await consumer(store).handle(events('threadCreate'));

    expect(states.size).toBe(0);
  });

  test('a channel event carrying no guild id is ignored rather than cached under null', async () => {
    const { store, states } = memoryStore();

    await consumer(store).handle({
      type: 'entity.channel_created',
      guildId: null,
      payload: { id: CHANNEL, type: 1 },
    });

    expect(states.get(GUILD)?.channels.size).toBe(0);
  });

  test('a deletion with no channel id is ignored rather than clearing something else', async () => {
    const { store, states } = memoryStore();
    const c = consumer(store);

    await c.handle(events('threadCreate'));
    await c.handle({ type: 'entity.thread_deleted', guildId: GUILD, payload: {} });

    expect(states.get(GUILD)?.channels.has(THREAD)).toBe(true);
  });
});
