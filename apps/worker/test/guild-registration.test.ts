import { describe, expect, test } from 'bun:test';
import type { GuildState, GuildStateStore } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { type GuildRegistrar, GuildStateConsumer } from '../src/guild-state-consumer.ts';

const BOT = '1200000000000000001';

function recordingRegistrar() {
  const ensured: Array<{ guildId: string; name: string; locale?: string }> = [];
  const left: string[] = [];

  const registrar: GuildRegistrar = {
    ensure: async (guildId, name, extra) => {
      ensured.push({ guildId, name, ...(extra?.locale ? { locale: extra.locale } : {}) });
    },
    markLeft: async (guildId) => {
      left.push(guildId);
    },
  };

  return { registrar, ensured, left };
}

function memoryStore() {
  const states = new Map<string, GuildState>();
  const store: GuildStateStore = {
    get: async (id) => states.get(id) ?? null,
    put: async (state) => {
      states.set(state.guildId, state);
    },
    patch: async () => undefined,
    delete: async (id) => {
      states.delete(id);
    },
  };
  return { store, states };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function consumer(registrar: GuildRegistrar, store: GuildStateStore) {
  return new GuildStateConsumer({
    bus: { publish: async () => {}, subscribe: () => ({ group: 'x', close: async () => {} }) },
    store,
    registrar,
    botUserId: BOT,
    logger: silent,
  });
}

describe('guild registration on GUILD_CREATE', () => {
  test('registers the guild in the database, not only the Redis cache', async () => {
    const { registrar, ensured } = recordingRegistrar();
    const { store, states } = memoryStore();
    const event = normalise(dispatch('guildCreate'));
    if (!event) throw new Error('fixture did not normalise');

    await consumer(registrar, store).handle(event);

    expect(ensured).toHaveLength(1);
    expect(ensured[0]?.guildId).toBe('900000000000000001');
    expect(ensured[0]?.name).toBe('Proton Test Guild');

    expect(states.has('900000000000000001')).toBe(true);
  });

  test('carries the guild’s locale through', async () => {
    const { registrar, ensured } = recordingRegistrar();
    const { store } = memoryStore();
    const event = normalise(dispatch('guildCreate'));
    if (!event) throw new Error('fixture did not normalise');

    await consumer(registrar, store).handle(event);

    expect(ensured[0]?.locale).toBe('en-US');
  });

  test('re-registers without complaint on redelivery', async () => {
    const { registrar, ensured } = recordingRegistrar();
    const { store } = memoryStore();
    const event = normalise(dispatch('guildCreate'));
    if (!event) throw new Error('fixture did not normalise');

    const c = consumer(registrar, store);
    await c.handle(event);
    await c.handle(event);

    expect(ensured).toHaveLength(2);
  });

  test('a registration failure propagates so the event is retried', async () => {
    const failing: GuildRegistrar = {
      ensure: async () => {
        throw new Error('api down');
      },
      markLeft: async () => {},
    };
    const { store, states } = memoryStore();
    const event = normalise(dispatch('guildCreate'));
    if (!event) throw new Error('fixture did not normalise');

    await expect(consumer(failing, store).handle(event)).rejects.toThrow('api down');

    expect(states.size).toBe(0);
  });
});

describe('GUILD_DELETE means two different things', () => {
  test('an outage clears the cache but does NOT retire the guild', async () => {
    const { registrar, left } = recordingRegistrar();
    const { store, states } = memoryStore();

    await store.put({
      guildId: '900000000000000001',
      ownerId: '2',
      everyoneRoleId: '900000000000000001',
      roles: new Map(),
      botRoleIds: [],
      channels: new Map(),
      updatedAt: Date.now(),
    });

    await consumer(registrar, store).handle({
      type: 'guild.unavailable',
      guildId: '900000000000000001',

      payload: { id: '900000000000000001', unavailable: true },
    });

    expect(states.size).toBe(0);
    expect(left).toEqual([]);
  });

  test('an actual removal marks the guild as left', async () => {
    const { registrar, left } = recordingRegistrar();
    const { store } = memoryStore();

    await consumer(registrar, store).handle({
      type: 'guild.unavailable',
      guildId: '900000000000000001',
      payload: { id: '900000000000000001' },
    });

    expect(left).toEqual(['900000000000000001']);
  });
});
