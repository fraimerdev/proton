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
import { type StarboardConfig, starboardConfigSchema } from '../src/config.ts';
import { createStarboardListener } from '../src/listener.ts';
import type { SourceMessage } from '../src/source.ts';
import type { StarboardPost, StarboardStore } from '../src/store.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const SOURCE = '500000000000000001';
const BOARD = '500000000000000009';
const MESSAGE = '1400000000000000001';
const BOARD_POST = '1400000000000000099';
const AUTHOR = '100000000000000001';
const STARRER = '100000000000000002';
const OTHER_STARRER = '100000000000000003';

const SESSION = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function added(userId: string, s: number): string {
  return `reaction.added:${SOURCE}:${MESSAGE}:${userId}:⭐:${SESSION}:${s}`;
}

function removed(userId: string, s: number): string {
  return `reaction.removed:${SOURCE}:${MESSAGE}:${userId}:⭐:${SESSION}:${s}`;
}

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
    return { status: 200, body: { id: BOARD_POST } };
  }
}

class MemoryStore implements StarboardStore {
  readonly rows = new Map<string, StarboardPost>();
  setCountFailures = 0;

  async get(guildId: string, sourceMessageId: string): Promise<StarboardPost | null> {
    return this.rows.get(`${guildId}:${sourceMessageId}`) ?? null;
  }

  async record(post: StarboardPost): Promise<boolean> {
    const key = `${post.guildId}:${post.sourceMessageId}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, post);
    return true;
  }

  async setCount(guildId: string, sourceMessageId: string, starCount: number): Promise<void> {
    if (this.setCountFailures > 0) {
      this.setCountFailures -= 1;
      throw new Error('the database connection dropped');
    }
    const key = `${guildId}:${sourceMessageId}`;
    const row = this.rows.get(key);
    if (row) this.rows.set(key, { ...row, starCount });
  }

  async remove(guildId: string, sourceMessageId: string): Promise<void> {
    this.rows.delete(`${guildId}:${sourceMessageId}`);
  }
}

function sourceMessage(stars: number): SourceMessage {
  return {
    id: MESSAGE,
    channelId: SOURCE,
    authorId: AUTHOR,
    authorBot: false,
    authorName: 'Author',
    authorAvatarUrl: null,
    content: 'worth a star',
    attachments: [],
    reactions: [{ emoji: { id: null, name: '⭐' }, count: stars }],
    channelNsfw: false,
    starredBy: [],
  };
}

function harness(postedAt: number) {
  const rest = new FakeRest();
  const store = new MemoryStore();
  const errors: string[] = [];
  const live = { stars: postedAt };

  store.rows.set(`${GUILD}:${MESSAGE}`, {
    guildId: GUILD,
    sourceMessageId: MESSAGE,
    boardMessageId: BOARD_POST,
    starCount: postedAt,
    createdAt: new Date(0),
  });

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
      channelId: BOARD,
    }),
  });

  const ctx: ModuleContext<StarboardConfig> = {
    guildId: GUILD,
    config: starboardConfigSchema.parse({ enabled: true, boardChannelId: BOARD, threshold: 3 }),
    executor,
    logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
  };

  const listener = createStarboardListener({
    store,
    readMessage: async () => sourceMessage(live.stars),
  });

  const handle = (type: 'reaction.added' | 'reaction.removed', id: string, userId: string) =>
    listener.handler(star(type, id, userId), ctx);

  const boardCounts = () =>
    rest.calls
      .filter((call) => call.method === 'PATCH')
      .map((call) => Number(/\*\*(\d+)\*\*/.exec((call.body as { content: string }).content)?.[1]));

  const storedCount = async () => (await store.get(GUILD, MESSAGE))?.starCount;

  return { live, store, handle, boardCounts, storedCount, errors };
}

function star(
  type: 'reaction.added' | 'reaction.removed',
  id: string,
  userId: string,
): ProtonEvent {
  return {
    id,
    type,
    guildId: GUILD,
    occurredAt: 0,
    payload: {
      user_id: userId,
      channel_id: SOURCE,
      message_id: MESSAGE,
      guild_id: GUILD,
      emoji: { id: null, name: '⭐' },
    },
  };
}

describe('the board post under at-least-once delivery', () => {
  test('a star taken off and put back by the same member moves the board both ways', async () => {
    const { live, handle, boardCounts, storedCount, errors } = harness(3);

    live.stars = 4;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    live.stars = 3;
    await handle('reaction.removed', removed(STARRER, 22), STARRER);
    live.stars = 4;
    await handle('reaction.added', added(STARRER, 23), STARRER);

    expect(boardCounts()).toEqual([4, 3, 4]);
    expect(await storedCount()).toBe(4);
    expect(errors).toEqual([]);
  });

  test('a redelivered star that reads a newer count leaves that count to the star behind it', async () => {
    const { live, handle, boardCounts, storedCount } = harness(3);

    live.stars = 4;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    live.stars = 5;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    await handle('reaction.added', added(OTHER_STARRER, 24), OTHER_STARRER);

    expect(boardCounts()).toEqual([4, 5]);
    expect(await storedCount()).toBe(5);
  });

  test('a star whose count failed to save is saved on redelivery, so the unstar behind it moves the board', async () => {
    const { live, store, handle, boardCounts, storedCount } = harness(3);

    live.stars = 4;
    store.setCountFailures = 1;
    await expect(handle('reaction.added', added(STARRER, 21), STARRER)).rejects.toThrow(
      'the database connection dropped',
    );
    await handle('reaction.added', added(STARRER, 21), STARRER);
    live.stars = 3;
    await handle('reaction.removed', removed(STARRER, 22), STARRER);

    expect({ board: boardCounts(), stored: await storedCount() }).toEqual({
      board: [4, 3],
      stored: 3,
    });
  });

  test('a star redelivered on RESUME edits the board once', async () => {
    const { live, handle, boardCounts, storedCount } = harness(3);

    live.stars = 4;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    await handle('reaction.added', added(STARRER, 21), STARRER);

    expect(boardCounts()).toEqual([4]);
    expect(await storedCount()).toBe(4);
  });
});
