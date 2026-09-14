import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type DedupeStore,
  DefaultActionExecutor,
  type ModuleContext,
  newId,
  type PrecheckInput,
  type ProtonEvent,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import type { RolemenuConfig } from '../src/config.ts';
import { handleReaction } from '../src/reactions.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const CHANNEL = '500000000000000001';
const MESSAGE = '1400000000000000001';
const MEMBER = '100000000000000002';
const ROLE = '800000000000000001';

const SESSION = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const NATURAL = `${CHANNEL}:${MESSAGE}:${MEMBER}:⭐`;

const ADDED = `reaction.added:${NATURAL}:${SESSION}:21`;
const REMOVED = `reaction.removed:${NATURAL}:${SESSION}:22`;
const ADDED_AGAIN = `reaction.added:${NATURAL}:${SESSION}:23`;
const REMOVED_AGAIN = `reaction.removed:${NATURAL}:${SESSION}:24`;

const ROLE_PATH = `/guilds/${GUILD}/members/${MEMBER}/roles/${ROLE}`;

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  async record(_input: CaseInput): Promise<{ caseId: string }> {
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return { status: 204, body: undefined };
  }
}

function harness() {
  const rest = new FakeRest();
  const errors: string[] = [];

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder: new MemoryRecorder(),
    resolveContext: async (): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: OWNER,
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: 0n,
      requiredPermissions: 0n,
    }),
  });

  const ctx: ModuleContext<RolemenuConfig> = {
    guildId: GUILD,
    config: {
      enabled: true,
      menus: [
        {
          id: 'stars',
          channelId: CHANNEL,
          messageId: MESSAGE,
          kind: 'reaction',
          mode: 'toggle',
          bindings: [{ key: '⭐', roleId: ROLE }],
        },
      ],
    },
    executor,
    logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
  };

  const react = (id: string) =>
    handleReaction(event('reaction.added', id), ctx, { botUserId: BOT });
  const unreact = (id: string) =>
    handleReaction(event('reaction.removed', id), ctx, { botUserId: BOT });
  const roleCalls = () => rest.calls.map((call) => `${call.method} ${call.path}`);

  return { react, unreact, roleCalls, errors };
}

function event(type: 'reaction.added' | 'reaction.removed', id: string): ProtonEvent {
  const raw = dispatch(type === 'reaction.added' ? 'messageReactionAdd' : 'messageReactionRemove');
  return { id, type, guildId: GUILD, occurredAt: 0, payload: raw.d };
}

describe('a reaction menu under at-least-once delivery', () => {
  test('a member who takes the reaction off and puts it back gets the role back', async () => {
    const { react, unreact, roleCalls, errors } = harness();

    await react(ADDED);
    await unreact(REMOVED);
    const again = await react(ADDED_AGAIN);
    await unreact(REMOVED_AGAIN);

    expect(roleCalls()).toEqual([
      `PUT ${ROLE_PATH}`,
      `DELETE ${ROLE_PATH}`,
      `PUT ${ROLE_PATH}`,
      `DELETE ${ROLE_PATH}`,
    ]);
    expect(again).toEqual({ action: 'applied', menuId: 'stars', added: [ROLE], removed: [] });
    expect(errors).toEqual([]);
  });

  test('a reaction redelivered on RESUME gives the role once and still reports it given', async () => {
    const { react, roleCalls } = harness();

    const first = await react(ADDED);
    const replayed = await react(ADDED);

    expect(roleCalls()).toEqual([`PUT ${ROLE_PATH}`]);
    expect(replayed).toEqual(first);
    expect(replayed).toEqual({ action: 'applied', menuId: 'stars', added: [ROLE], removed: [] });
  });
});
