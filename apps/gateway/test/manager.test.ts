import { describe, expect, test } from 'bun:test';
import { WebSocketShardEvents } from '@discordjs/ws';
import type { EventBus, ProtonEvent } from '@proton/core';
import type { GatewayDispatchPayload } from 'discord-api-types/v10';
import { DEFAULT_PRESENCE } from '../src/env.ts';
import { createGatewayManager } from '../src/manager.ts';
import type { SessionInfo } from '../src/session-store.ts';

const GUILD = '900000000000000001';
const MEMBER = '400000000000000001';

function session(sessionId: string, shardId = 0): SessionInfo {
  return { sessionId, sequence: 1, shardId, shardCount: 2, resumeURL: 'wss://gateway.invalid' };
}

function removal(s: number): GatewayDispatchPayload {
  return {
    op: 0,
    t: 'GUILD_MEMBER_REMOVE',
    s,
    d: { guild_id: GUILD, user: { id: MEMBER } },
  } as unknown as GatewayDispatchPayload;
}

function harness(initial: SessionInfo[] = []) {
  const stored = new Map<number, SessionInfo>();
  for (const info of initial) stored.set(info.shardId, info);

  const published: ProtonEvent[] = [];
  const bus: EventBus = {
    publish: async (event) => {
      published.push(event);
    },
    subscribe: () => {
      throw new Error('the gateway only publishes');
    },
  };

  const { ws: manager } = createGatewayManager({
    token: 'not-a-real-token',
    intents: 0,
    presence: DEFAULT_PRESENCE,
    restProxyUrl: 'http://127.0.0.1:9',
    store: {
      retrieveSessionInfo: async (shardId) => stored.get(shardId) ?? null,
      updateSessionInfo: async (shardId, info) => {
        if (info) stored.set(shardId, info);
        else stored.delete(shardId);
      },
    },
    bus,
    exit: (code) => {
      throw new Error(`the gateway tried to exit with code ${code}`);
    },
  });

  async function leave(s: number, shardId = 0): Promise<string | undefined> {
    const before = published.length;
    manager.emit(WebSocketShardEvents.Dispatch, removal(s), shardId);
    await Bun.sleep(0);
    return published.slice(before).find((event) => event.type === 'member.left')?.id;
  }

  return { manager, stored, leave };
}

describe('member.left ids carry the shard session', () => {
  test('the READY session id reaches member.left events on that shard', async () => {
    const { manager, leave } = harness();

    await manager.options.updateSessionInfo(0, session('ready-session'));

    expect(await leave(5)).toBe(`member.left:${GUILD}:${MEMBER}:ready-session:5`);
  });

  test('a removal replayed on RESUME keeps the id of the one it repeats', async () => {
    const { manager, leave } = harness();
    await manager.options.updateSessionInfo(0, session('ready-session'));
    const first = await leave(5);

    await manager.options.retrieveSessionInfo(0);

    expect(await leave(5)).toBe(first);
  });

  test('a boot that resumes a stored session keys removals on that session', async () => {
    const { manager, leave } = harness([session('stored-session')]);

    await manager.options.retrieveSessionInfo(0);

    expect(await leave(5)).toBe(`member.left:${GUILD}:${MEMBER}:stored-session:5`);
  });

  test('a re-identify gives a later leave on the same sequence number a new id', async () => {
    const { manager, leave } = harness();
    await manager.options.updateSessionInfo(0, session('first-session'));
    const before = await leave(5);

    await manager.options.updateSessionInfo(0, null);
    await manager.options.updateSessionInfo(0, session('second-session'));
    const after = await leave(5);

    expect(after).toBe(`member.left:${GUILD}:${MEMBER}:second-session:5`);
    expect(after).not.toBe(before);
  });

  test('each shard keys removals on its own session', async () => {
    const { manager, leave } = harness();
    await manager.options.updateSessionInfo(0, session('shard-zero', 0));
    await manager.options.updateSessionInfo(1, session('shard-one', 1));

    expect(await leave(5, 1)).toBe(`member.left:${GUILD}:${MEMBER}:shard-one:5`);
    expect(await leave(5, 0)).toBe(`member.left:${GUILD}:${MEMBER}:shard-zero:5`);
  });

  test('before any session is known a removal keeps the sequence-only key', async () => {
    const { leave } = harness();

    expect(await leave(5)).toBe(`member.left:${GUILD}:${MEMBER}:5`);
  });

  test('session writes and deletes still reach the store', async () => {
    const { manager, stored } = harness();

    await manager.options.updateSessionInfo(0, session('ready-session'));
    expect(stored.get(0)?.sessionId).toBe('ready-session');

    await manager.options.updateSessionInfo(0, null);
    expect(stored.has(0)).toBe(false);
  });
});
