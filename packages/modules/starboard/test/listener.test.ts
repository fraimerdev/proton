import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type DedupeStore,
  DefaultActionExecutor,
  type EventType,
  type ModuleContext,
  newId,
  type PrecheckInput,
  type ProtonEvent,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
} from '@proton/core';
import { type StarboardConfig, starboardConfigSchema } from '../src/config.ts';
import { createStarboardModule } from '../src/index.ts';
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
const THIRD_STARRER = '100000000000000004';

const UNKNOWN_MESSAGE: RestResponse = {
  status: 404,
  body: { message: 'Unknown Message', code: 10008 },
};

const MISSING_PERMISSIONS: RestResponse = {
  status: 403,
  body: { message: 'Missing Permissions', code: 50013 },
};

const ALREADY_SENT =
  `The starboard sent, or is still sending, a board post for ${MESSAGE} to <#${BOARD}> in the ` +
  'last day and has no record of it, so it did not send another. If that post has since been ' +
  'taken down, by a moderator or because its stars fell below the threshold, the message ' +
  'cannot go back on the board until a day after the post was sent.';

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
  readonly answers = new Map<string, RestResponse>();

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.answers.get(options.method) ?? { status: 200, body: { id: BOARD_POST } };
  }
}

class MemoryStore implements StarboardStore {
  readonly rows = new Map<string, StarboardPost>();
  setCountFailures = 0;
  recordFailures = 0;

  async get(guildId: string, sourceMessageId: string): Promise<StarboardPost | null> {
    return this.rows.get(`${guildId}:${sourceMessageId}`) ?? null;
  }

  async record(post: StarboardPost): Promise<boolean> {
    if (this.recordFailures > 0) {
      this.recordFailures -= 1;
      throw new Error('the database connection dropped');
    }
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

function harness(postedAt: number | null) {
  const rest = new FakeRest();
  const store = new MemoryStore();
  const errors: string[] = [];
  const errorCodes: unknown[] = [];
  const warnings: string[] = [];
  const published: { type: EventType; key: string; payload: unknown }[] = [];
  const bus = { failures: 0 };
  const live = { stars: postedAt ?? 0 };

  if (postedAt !== null) {
    store.rows.set(`${GUILD}:${MESSAGE}`, {
      guildId: GUILD,
      sourceMessageId: MESSAGE,
      boardMessageId: BOARD_POST,
      starCount: postedAt,
      createdAt: new Date(-60_000),
    });
  }

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
    logger: {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: (message, meta) => {
        errors.push(message);
        errorCodes.push(meta?.code);
      },
    },
    async publish(type, key, payload) {
      if (bus.failures > 0) {
        bus.failures -= 1;
        throw new Error('the bus is unreachable');
      }
      published.push({ type, key, payload });
    },
  };

  const listener = createStarboardListener({
    store,
    readMessage: async () => sourceMessage(live.stars),
  });

  const handle = (
    type: 'reaction.added' | 'reaction.removed',
    id: string,
    userId: string,
    occurredAt = 0,
  ) => listener.handler(star(type, id, userId, occurredAt), ctx);

  const boardCounts = () =>
    rest.calls
      .filter((call) => call.method === 'PATCH')
      .map((call) => Number(/\*\*(\d+)\*\*/.exec((call.body as { content: string }).content)?.[1]));

  const storedCount = async () => (await store.get(GUILD, MESSAGE))?.starCount;

  const methods = () => rest.calls.map((call) => call.method);

  return {
    live,
    rest,
    store,
    handle,
    boardCounts,
    storedCount,
    methods,
    errors,
    errorCodes,
    warnings,
    published,
    bus,
  };
}

function star(
  type: 'reaction.added' | 'reaction.removed',
  id: string,
  userId: string,
  occurredAt = 0,
): ProtonEvent {
  return {
    id,
    type,
    guildId: GUILD,
    occurredAt,
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

describe('a board post Discord refuses or no longer has', () => {
  test('an edit answered with Unknown Message forgets the post and warns', async () => {
    const { live, rest, store, handle, methods, errors, warnings } = harness(3);
    rest.answers.set('PATCH', UNKNOWN_MESSAGE);

    live.stars = 4;
    await handle('reaction.added', added(STARRER, 21), STARRER);

    expect(methods()).toEqual(['PATCH']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(warnings).toEqual([
      `The board post for ${MESSAGE} is gone from <#${BOARD}>, so the starboard has forgotten it.`,
    ]);
    expect(errors).toEqual([]);
  });

  test('a delete answered with Unknown Message removes the row without an error', async () => {
    const { live, rest, store, handle, methods, errors } = harness(3);
    rest.answers.set('DELETE', UNKNOWN_MESSAGE);

    live.stars = 2;
    await handle('reaction.removed', removed(STARRER, 22), STARRER);

    expect(methods()).toEqual(['DELETE']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('a star after the board post vanished neither posts it again nor logs an error', async () => {
    const { live, rest, store, handle, methods, errors, warnings } = harness(null);

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    rest.answers.set('PATCH', UNKNOWN_MESSAGE);
    live.stars = 4;
    await handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER);
    live.stars = 5;
    await handle('reaction.added', added(THIRD_STARRER, 23), THIRD_STARRER);

    expect(methods()).toEqual(['POST', 'PATCH']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(errors).toEqual([]);
    expect(warnings.at(-1)).toBe(ALREADY_SENT);
  });

  test('a message that dips below the threshold and comes back within the day stays off the board, and the warn says why', async () => {
    const { live, store, handle, methods, errors, warnings } = harness(null);

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    live.stars = 2;
    await handle('reaction.removed', removed(STARRER, 22), STARRER);
    live.stars = 3;
    await handle('reaction.added', added(STARRER, 23), STARRER);

    expect(methods()).toEqual(['POST', 'DELETE']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(errors).toEqual([]);
    expect(warnings).toEqual([ALREADY_SENT]);
  });

  test('a post whose reply carried no id is reported as untracked, and the next star does not post it again', async () => {
    const { live, rest, store, handle, methods, errors, warnings } = harness(null);
    rest.answers.set('POST', { status: 200, body: {} });

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER);
    rest.answers.delete('POST');
    live.stars = 4;
    await handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER);

    expect(methods()).toEqual(['POST']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(errors).toEqual([
      `The starboard posted ${MESSAGE} to <#${BOARD}> but Discord's reply carried no message ` +
        'id, so the starboard cannot track that post: its star count will not update, and it ' +
        'will not be taken down if its stars fall below the threshold.',
    ]);
    expect(warnings).toEqual([ALREADY_SENT]);
  });

  test('stars arriving together send one board post', async () => {
    const { live, store, handle, methods, errors, warnings } = harness(null);

    live.stars = 3;
    await Promise.all([
      handle('reaction.added', added(STARRER, 21), STARRER),
      handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER),
    ]);

    expect(methods()).toEqual(['POST']);
    expect(await store.get(GUILD, MESSAGE)).toMatchObject({
      boardMessageId: BOARD_POST,
      starCount: 3,
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([ALREADY_SENT]);
  });

  test('stars arriving together whose one post is refused report the refusal once', async () => {
    const { live, rest, store, handle, methods, errors, errorCodes, warnings } = harness(null);
    rest.answers.set('POST', MISSING_PERMISSIONS);

    live.stars = 3;
    await Promise.all([
      handle('reaction.added', added(STARRER, 21), STARRER),
      handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER),
    ]);

    expect(methods()).toEqual(['POST']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(`The starboard could not post ${MESSAGE} to <#${BOARD}>: `);
    expect(errorCodes).toEqual(['discord_403']);
    expect(warnings).toEqual([ALREADY_SENT]);
  });

  test('a post whose row failed to save is not posted twice on redelivery, and the orphan is warned about', async () => {
    const { live, store, handle, methods, errors, warnings } = harness(null);

    live.stars = 3;
    store.recordFailures = 1;
    await expect(handle('reaction.added', added(STARRER, 21), STARRER)).rejects.toThrow(
      'the database connection dropped',
    );
    await handle('reaction.added', added(STARRER, 21), STARRER);

    expect(methods()).toEqual(['POST']);
    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(errors).toEqual([]);
    expect(warnings).toEqual([ALREADY_SENT]);
  });

  test('an edit answered with Missing Permissions keeps the post and reports the refusal', async () => {
    const { live, rest, store, handle, methods, errors, errorCodes, warnings } = harness(3);
    rest.answers.set('PATCH', MISSING_PERMISSIONS);

    live.stars = 4;
    await handle('reaction.added', added(STARRER, 21), STARRER);

    expect(methods()).toEqual(['PATCH']);
    expect(await store.get(GUILD, MESSAGE)).toMatchObject({
      boardMessageId: BOARD_POST,
      starCount: 3,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(`The starboard could not update the board post for ${MESSAGE}: `);
    expect(errorCodes).toEqual(['discord_403']);
    expect(warnings).toEqual([]);
  });
});

describe('announcing a message that reached the board', () => {
  const STARRED_AT = 1_790_000_000_000;
  const KEY = `${MESSAGE}:${BOARD_POST}`;

  const POSTED = {
    guildId: GUILD,
    sourceMessageId: MESSAGE,
    sourceChannelId: SOURCE,
    authorId: AUTHOR,
    authorBot: false,
    boardMessageId: BOARD_POST,
    starCount: 3,
    activityAt: STARRED_AT,
  };

  test('the manifest declares the event', () => {
    expect(createStarboardModule().emits).toEqual(['starboard.message_posted']);
  });

  test('the star that posts it publishes once, keyed on the source and board messages', async () => {
    const { live, handle, published, errors } = harness(null);

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);
    live.stars = 4;
    await handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER, STARRED_AT + 1_000);

    expect(published).toEqual([{ type: 'starboard.message_posted', key: KEY, payload: POSTED }]);
    expect(errors).toEqual([]);
  });

  test('the star that posted it, redelivered, publishes again under the same key', async () => {
    const { live, handle, methods, published } = harness(null);

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    expect(methods()).toEqual(['POST']);
    expect(published).toEqual([
      { type: 'starboard.message_posted', key: KEY, payload: POSTED },
      { type: 'starboard.message_posted', key: KEY, payload: POSTED },
    ]);
  });

  test('a redelivery after later stars moved the board keeps the time of the star that posted it', async () => {
    const { live, handle, published } = harness(null);

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);
    live.stars = 4;
    await handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER, STARRED_AT + 1_000);
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    expect(published.map((event) => event.key)).toEqual([KEY, KEY]);
    expect(published[1]?.payload).toEqual({ ...POSTED, starCount: 4 });
  });

  test('a publish the bus refuses is logged, not thrown, and the redelivery publishes it', async () => {
    const { live, store, handle, bus, published, errors } = harness(null);

    live.stars = 3;
    bus.failures = 1;
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    expect(await store.get(GUILD, MESSAGE)).toMatchObject({ boardMessageId: BOARD_POST });
    expect(published).toEqual([]);
    expect(errors).toEqual([
      `The starboard put ${MESSAGE} on the board but could not tell other modules, so ` +
        'Achievements will not count it: the bus is unreachable',
    ]);

    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    expect(published).toEqual([{ type: 'starboard.message_posted', key: KEY, payload: POSTED }]);
  });

  test('a row another star saved first is announced with that row’s board post', async () => {
    const { live, store, handle, published } = harness(null);
    const EARLIER_POST = '1400000000000000098';

    const record = store.record.bind(store);
    store.record = async (post) => {
      store.rows.set(`${GUILD}:${MESSAGE}`, { ...post, boardMessageId: EARLIER_POST });
      return record(post);
    };

    live.stars = 3;
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    expect(published).toEqual([
      {
        type: 'starboard.message_posted',
        key: `${MESSAGE}:${EARLIER_POST}`,
        payload: { ...POSTED, boardMessageId: EARLIER_POST },
      },
    ]);
  });

  test('nothing is published when nothing reaches the board', async () => {
    const { live, rest, store, handle, published } = harness(null);

    live.stars = 2;
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    rest.answers.set('POST', MISSING_PERMISSIONS);
    live.stars = 3;
    await handle('reaction.added', added(OTHER_STARRER, 22), OTHER_STARRER, STARRED_AT + 1_000);

    expect(await store.get(GUILD, MESSAGE)).toBeNull();
    expect(published).toEqual([]);
  });

  test('a post whose row failed to save publishes nothing, then or on redelivery', async () => {
    const { live, store, handle, published } = harness(null);

    live.stars = 3;
    store.recordFailures = 1;
    await expect(handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT)).rejects.toThrow(
      'the database connection dropped',
    );
    await handle('reaction.added', added(STARRER, 21), STARRER, STARRED_AT);

    expect(published).toEqual([]);
  });
});
