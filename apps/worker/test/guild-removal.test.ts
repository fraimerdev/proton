import { describe, expect, test } from 'bun:test';
import type { GuildStateStore } from '@proton/core';
import {
  type GuildRegistrar,
  GuildStateConsumer,
  type RemovedGuildCleanup,
} from '../src/guild-state-consumer.ts';

const GUILD = '900000000000000001';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function build(
  overrides: {
    cron?: RemovedGuildCleanup['cron'];
    markLeft?: GuildRegistrar['markLeft'];
    commands?: boolean;
  } = {},
) {
  const calls: string[] = [];

  const registrar: GuildRegistrar = {
    ensure: async () => {
      calls.push('ensure');
    },
    markLeft:
      overrides.markLeft ??
      (async (guildId) => {
        calls.push(`markLeft:${guildId}`);
        return true;
      }),
  };

  const store: GuildStateStore = {
    get: async () => null,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async (guildId) => {
      calls.push(`forgetState:${guildId}`);
    },
  };

  const removal: RemovedGuildCleanup = {
    cron: overrides.cron ?? {
      unregister: async (guildId) => {
        calls.push(`unregister:${guildId}`);
        return 1;
      },
    },
    ...(overrides.commands
      ? {
          commands: {
            forget: async (guildId: string) => {
              calls.push(`forgetCommands:${guildId}`);
            },
          },
        }
      : {}),
  };

  const consumer = new GuildStateConsumer({
    bus: { publish: async () => {}, subscribe: () => ({ group: 'x', close: async () => {} }) },
    store,
    registrar,
    botUserId: '1200000000000000001',
    logger: silent,
    removal,
  });

  return { consumer, calls };
}

const removed = {
  id: `guild.unavailable:${GUILD}:removed`,
  type: 'guild.unavailable',
  guildId: GUILD,
  payload: { id: GUILD },
};

describe('when Proton is removed from a server', () => {
  test('once Discord confirms it, the cached state and cron rules go and nothing else', async () => {
    const { consumer, calls } = build();

    await consumer.handle(removed);

    expect(calls).toEqual([`markLeft:${GUILD}`, `forgetState:${GUILD}`, `unregister:${GUILD}`]);
  });

  test('a removal Discord contradicts is older than a rejoin and forgets nothing', async () => {
    const { consumer, calls } = build({
      markLeft: async (guildId) => {
        calls.push(`markLeft:${guildId}`);
        return false;
      },
    });

    await consumer.handle(removed);

    expect(calls).toEqual([`markLeft:${GUILD}`]);
  });

  test('a removal that cannot be confirmed propagates and forgets nothing yet', async () => {
    const { consumer, calls } = build({
      markLeft: async () => {
        throw new Error('api returned 503');
      },
    });

    await expect(consumer.handle(removed)).rejects.toThrow('api returned 503');
    expect(calls).toEqual([]);
  });

  test('an outage clears the cached state and nothing else: the server is coming back', async () => {
    const { consumer, calls } = build();

    await consumer.handle({ ...removed, payload: { id: GUILD, unavailable: true } });

    expect(calls).toEqual([`forgetState:${GUILD}`]);
  });

  test('a cleanup that fails propagates, so the removal is redelivered and retried', async () => {
    const { consumer } = build({
      cron: {
        unregister: async () => {
          throw new Error('redis down');
        },
      },
    });

    await expect(consumer.handle(removed)).rejects.toThrow('redis down');
  });

  test('a confirmed removal also forgets the command registration record', async () => {
    const { consumer, calls } = build({ commands: true });

    await consumer.handle(removed);

    expect(calls).toEqual([
      `markLeft:${GUILD}`,
      `forgetState:${GUILD}`,
      `unregister:${GUILD}`,
      `forgetCommands:${GUILD}`,
    ]);
  });

  test('a removal Discord contradicts keeps the command record too', async () => {
    const { consumer, calls } = build({
      commands: true,
      markLeft: async (guildId) => {
        calls.push(`markLeft:${guildId}`);
        return false;
      },
    });

    await consumer.handle(removed);

    expect(calls).toEqual([`markLeft:${GUILD}`]);
  });

  test('a redelivered removal runs again without complaint', async () => {
    const { consumer, calls } = build();

    await consumer.handle(removed);
    await consumer.handle(removed);

    expect(calls.filter((call) => call.startsWith('unregister'))).toHaveLength(2);
  });
});
