import { describe, expect, test } from 'bun:test';
import {
  DefaultActionExecutor,
  type GuildState,
  type ModuleContext,
  resolvePrecheckContext,
} from '@proton/core';
import type { GiveawaysConfig } from '../src/config.ts';
import { dmWinner } from '../src/perform.ts';

const GUILD = '100000000000000000';
const OWNER = '400000000000000009';
const BOT = '300000000000000001';
const CHANNEL = '500000000000000000';
const DM_CHANNEL = '800000000000000000';
const WINNER = '400000000000002001';

function withholdingEverything(): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([[GUILD, { id: GUILD, permissions: 0n, position: 0 }]]),
    botRoleIds: [],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

function rig(state: GuildState | null) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const warnings: string[] = [];
  const claimed = new Set<string>();

  const executor = new DefaultActionExecutor({
    dedupe: {
      claim: async (key) => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      release: async (key) => {
        claimed.delete(key);
      },
      has: async (key) => claimed.has(key),
    },
    rest: {
      request: async ({ method, path, body }) => {
        calls.push({ method, path, body });
        return path === '/users/@me/channels'
          ? { status: 200, body: { id: DM_CHANNEL, type: 1 } }
          : { status: 200, body: { id: '700000000000000001' } };
      },
    },
    recorder: { record: async () => ({ caseId: 'case' }) },
    resolveContext: async (request) => {
      const resolved = await resolvePrecheckContext(
        {
          store: {
            get: async () => state,
            put: async () => undefined,
            patch: async () => undefined,
            delete: async () => undefined,
          },
          botUserId: BOT,
        },
        request,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const ctx = {
    guildId: GUILD,
    executor,
    logger: {
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
      error() {},
    },
  } as unknown as ModuleContext<GiveawaysConfig>;

  return { ctx, calls, warnings };
}

describe('the winner direct message', () => {
  test('reaches the winner from a server that grants Proton neither View Channel nor Send Messages', async () => {
    const { ctx, calls, warnings } = rig(withholdingEverything());

    expect(await dmWinner(ctx, WINNER, 'You won Nitro Classic.', 'giveaways:g1:draw')).toBe('sent');

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /users/@me/channels',
      `POST /channels/${DM_CHANNEL}/messages`,
    ]);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('directMessage');
    expect(warnings).toEqual([]);
  });

  test('is still sent while this server’s state has not loaded', async () => {
    const { ctx, calls, warnings } = rig(null);

    expect(await dmWinner(ctx, WINNER, 'You won Nitro Classic.', 'giveaways:g1:draw')).toBe('sent');

    expect(calls).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});
