import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { moderationConfigSchema } from '../src/config.ts';
import {
  HISTORY_CONTENT_MAX,
  HISTORY_DELETED_MS,
  HISTORY_PER_CHANNEL,
  HISTORY_WINDOW_MS,
  historyKey,
  historyMessageKey,
  purgeGuild,
  RedisMessageHistoryBuffer,
  recordCreated,
  recordDeleted,
  retainHistory,
} from '../src/punish/history.ts';
import type { BufferedMessage } from '../src/punish/store.ts';
import {
  messageCreatedEvent,
  messageDeletedEvent,
  rawAttachment,
  rawMessage,
  rawUser,
} from './drivers.ts';
import { CHANNEL, GUILD, MEMBER, REPORTER } from './harness.ts';

const MINUTE = 60_000;
const OTHER_CHANNEL = '500000000000000002';
const OTHER_GUILD = '900000000000000002';

class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly expiries = new Map<string, number>();

  constructor(readonly now: () => number) {}

  #drop(key: string): boolean {
    const existed = this.strings.delete(key) || this.hashes.delete(key);
    this.expiries.delete(key);
    return existed;
  }

  #live(key: string): void {
    const at = this.expiries.get(key);
    if (at !== undefined && at <= this.now()) this.#drop(key);
  }

  keys(): string[] {
    for (const key of [...this.strings.keys(), ...this.hashes.keys()]) this.#live(key);
    return [...this.strings.keys(), ...this.hashes.keys()].sort();
  }

  ttl(key: string): number | null {
    this.#live(key);
    const at = this.expiries.get(key);
    return at === undefined ? null : at - this.now();
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.#live(key);
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const added = hash.has(field) ? 0 : 1;
    hash.set(field, value);
    this.hashes.set(key, hash);
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.#live(key);
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.#live(key);
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.#live(key);
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) if (hash.delete(field)) removed += 1;
    if (hash.size === 0) this.#drop(key);
    return removed;
  }

  async set(key: string, value: string, _px: 'PX', ms: number, nx?: 'NX'): Promise<'OK' | null> {
    this.#live(key);
    if (nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    this.expiries.set(key, this.now() + ms);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.#live(key);
    return this.strings.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.#drop(key)).length;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.#live(key);
    if (!this.strings.has(key) && !this.hashes.has(key)) return 0;
    this.expiries.set(key, this.now() + ms);
    return 1;
  }

  async scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _size: number,
  ): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return ['0', this.keys().filter((key) => key.startsWith(prefix))];
  }
}

function setup(start = 1_780_000_000_000) {
  let clock = start;
  const now = () => clock;
  const redis = new FakeRedis(now);
  const buffer = new RedisMessageHistoryBuffer(redis as unknown as Redis, { now });

  return {
    redis,
    buffer,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

let lastId = 1_400_000_000_000_000_100n;

function freshId(): string {
  lastId += 1n;
  return String(lastId);
}

function message(overrides: Partial<BufferedMessage> & { createdAt: number }): BufferedMessage {
  return {
    messageId: freshId(),
    channelId: CHANNEL,
    authorId: MEMBER,
    content: 'hello',
    attachments: [],
    deletedAt: null,
    ...overrides,
  };
}

const ON = moderationConfigSchema.parse({ punish: { messageHistory: true } });

describe('the case-history buffer', () => {
  test('keeps the newest five messages per channel', async () => {
    const { buffer, redis, now } = setup();
    const inFirst = Array.from({ length: 7 }, (_, index) =>
      message({ createdAt: now() - (7 - index) * MINUTE, content: `first ${index}` }),
    );
    const inSecond = [0, 1].map((index) =>
      message({ createdAt: now() - MINUTE, channelId: OTHER_CHANNEL, content: `second ${index}` }),
    );

    for (const entry of [...inFirst, ...inSecond]) await buffer.record(GUILD, entry);

    const recent = await buffer.recent(GUILD, MEMBER, now());
    expect(
      recent.filter((entry) => entry.channelId === CHANNEL).map((entry) => entry.content),
    ).toEqual(['first 2', 'first 3', 'first 4', 'first 5', 'first 6']);
    expect(recent.filter((entry) => entry.channelId === OTHER_CHANNEL)).toHaveLength(2);
    expect(Object.keys(await redis.hgetall(historyKey(GUILD, MEMBER)))).toHaveLength(
      HISTORY_PER_CHANNEL + 2,
    );
  });

  test('forgets a message an hour after it was sent, and the key expires with it', async () => {
    const { buffer, redis, now, advance } = setup();
    await buffer.record(GUILD, message({ createdAt: now() - 50 * MINUTE }));

    expect(await buffer.recent(GUILD, MEMBER, now())).toHaveLength(1);
    expect(redis.ttl(historyKey(GUILD, MEMBER))).toBe(10 * MINUTE);

    advance(10 * MINUTE);
    expect(await buffer.recent(GUILD, MEMBER, now())).toEqual([]);
    expect(redis.keys()).toEqual([]);
  });

  test('refuses a message that is already older than the window', async () => {
    const { buffer, redis, now } = setup();

    await buffer.record(GUILD, message({ createdAt: now() - HISTORY_WINDOW_MS }));

    expect(redis.keys()).toEqual([]);
  });

  test('keeps a deleted message for 30 minutes after it was deleted', async () => {
    const { buffer, now, advance } = setup();
    const sent = message({ createdAt: now(), content: 'deleted slur' });
    await buffer.record(GUILD, sent);

    advance(5 * MINUTE);
    const deletedAt = now();
    await buffer.markDeleted(GUILD, CHANNEL, sent.messageId, deletedAt);

    advance(HISTORY_DELETED_MS - MINUTE);
    expect(await buffer.recent(GUILD, MEMBER, now())).toMatchObject([
      { messageId: sent.messageId, content: 'deleted slur', deletedAt },
    ]);

    advance(2 * MINUTE);
    expect(await buffer.recent(GUILD, MEMBER, now())).toEqual([]);
  });

  test('a deletion processed before its message still marks the message deleted', async () => {
    const { buffer, now, advance } = setup();
    const sent = message({ createdAt: now() });
    const deletedAt = now() + MINUTE;

    advance(MINUTE);
    await buffer.markDeleted(GUILD, CHANNEL, sent.messageId, deletedAt);
    await buffer.record(GUILD, sent);

    expect(await buffer.recent(GUILD, MEMBER, now())).toMatchObject([{ deletedAt }]);

    advance(HISTORY_DELETED_MS);
    expect(await buffer.recent(GUILD, MEMBER, now())).toEqual([]);
  });

  test('a message delivered again after its deletion stays deleted', async () => {
    const { buffer, now, advance } = setup();
    const sent = message({ createdAt: now() });
    await buffer.record(GUILD, sent);

    advance(MINUTE);
    const deletedAt = now();
    await buffer.markDeleted(GUILD, CHANNEL, sent.messageId, deletedAt);
    await buffer.markDeleted(GUILD, CHANNEL, sent.messageId, now() + MINUTE);
    await buffer.record(GUILD, sent);

    expect(await buffer.recent(GUILD, MEMBER, now())).toMatchObject([{ deletedAt }]);
  });

  test('never keeps a deleted message past the hour', async () => {
    const { buffer, now, advance } = setup();
    const sent = message({ createdAt: now() });
    await buffer.record(GUILD, sent);

    advance(50 * MINUTE);
    await buffer.markDeleted(GUILD, CHANNEL, sent.messageId, now());

    advance(10 * MINUTE);
    expect(await buffer.recent(GUILD, MEMBER, now())).toEqual([]);
  });

  test('a delete for a message it never held changes nothing', async () => {
    const { buffer, redis, now } = setup();
    const sent = message({ createdAt: now() });
    await buffer.record(GUILD, sent);

    await buffer.markDeleted(GUILD, CHANNEL, '1499999999999999999', now());
    await buffer.markDeleted(GUILD, OTHER_CHANNEL, sent.messageId, now());

    expect((await buffer.recent(GUILD, MEMBER, now()))[0]?.deletedAt).toBeNull();
    expect(await redis.get(historyMessageKey(GUILD, CHANNEL, sent.messageId))).toBe(MEMBER);
  });

  test('purging a server removes its buffers only', async () => {
    const { buffer, redis, now } = setup();
    await buffer.record(GUILD, message({ createdAt: now() }));
    await buffer.record(GUILD, message({ createdAt: now(), authorId: REPORTER }));
    await buffer.record(OTHER_GUILD, message({ createdAt: now() }));

    await purgeGuild(buffer, GUILD);

    expect(redis.keys().every((key) => key.includes(`:${OTHER_GUILD}:`))).toBe(true);
    expect(await buffer.recent(OTHER_GUILD, MEMBER, now())).toHaveLength(1);
    expect(await buffer.recent(GUILD, MEMBER, now())).toEqual([]);
  });

  test('retention is the same on read as on write', () => {
    const at = 1_780_000_000_000;
    const kept = retainHistory(
      [
        message({ createdAt: at - HISTORY_WINDOW_MS }),
        message({ createdAt: at - MINUTE, deletedAt: at - HISTORY_DELETED_MS }),
        message({ createdAt: at - MINUTE, content: 'kept' }),
      ],
      at,
    );

    expect(kept.map((entry) => entry.content)).toEqual(['kept']);
  });
});

describe('feeding the buffer from gateway messages', () => {
  function created(options: Parameters<typeof rawMessage>[0] = {}, guildId: string | null = GUILD) {
    return messageCreatedEvent(rawMessage({ id: freshId(), ...options }), { guildId }).payload;
  }

  test('records a member message, clipped, with attachment details and no file', async () => {
    const { buffer, now } = setup();
    const long = 'x'.repeat(HISTORY_CONTENT_MAX + 50);
    const payload = created({
      content: long,
      at: now() - MINUTE,
      attachments: [rawAttachment({ filename: 'proof.png', size: 2048 })],
    });

    expect(await recordCreated(buffer, ON, payload, now())).toBe(true);

    const [stored] = await buffer.recent(GUILD, MEMBER, now());
    expect(stored?.content).toHaveLength(HISTORY_CONTENT_MAX);
    expect(stored?.createdAt).toBe(now() - MINUTE);
    expect(stored?.attachments).toEqual([
      {
        id: expect.any(String),
        filename: 'proof.png',
        contentType: 'image/png',
        size: 2048,
        url: expect.stringContaining('proof.png'),
        expiresAt: expect.any(Number),
      },
    ]);
  });

  test('skips bots, webhooks, direct messages and empty messages', async () => {
    const { buffer, redis, now } = setup();

    await recordCreated(buffer, ON, created({ author: rawUser(MEMBER, { bot: true }) }), now());
    await recordCreated(buffer, ON, created({ webhookId: '1300000000000000001' }), now());
    await recordCreated(buffer, ON, created({}, null), now());
    await recordCreated(buffer, ON, created({ content: '' }), now());

    expect(redis.keys()).toEqual([]);
  });

  test('records nothing while the setting or moderation is off', async () => {
    const { buffer, redis, now } = setup();
    const off = moderationConfigSchema.parse({});
    const disabled = moderationConfigSchema.parse({
      enabled: false,
      punish: { messageHistory: true },
    });

    expect(await recordCreated(buffer, off, created(), now())).toBe(false);
    expect(await recordCreated(buffer, disabled, created(), now())).toBe(false);
    expect(redis.keys()).toEqual([]);
  });

  test('a deletion from the gateway marks the buffered message', async () => {
    const { buffer, now } = setup();
    const id = freshId();
    await recordCreated(buffer, ON, created({ id, at: now() }), now());

    const deleted = messageDeletedEvent(CHANNEL, id).payload;
    expect(await recordDeleted(buffer, ON, deleted, now())).toBe(true);

    expect((await buffer.recent(GUILD, MEMBER, now()))[0]?.deletedAt).toBe(now());
    expect(await recordDeleted(buffer, moderationConfigSchema.parse({}), deleted, now())).toBe(
      false,
    );
  });
});
