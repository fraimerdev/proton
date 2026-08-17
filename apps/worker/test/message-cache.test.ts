import { describe, expect, test } from 'bun:test';
import type {
  CachedMessage,
  EventBus,
  Logger,
  MessageContentCache,
  ProtonEvent,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { loggingConfigSchema } from '@proton/module-logging';
import { MessageCacheConsumer, ttlOf } from '../src/message-cache.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const BOT = '100000000000000098';

class MemoryCache implements MessageContentCache {
  readonly stored = new Map<string, CachedMessage>();
  readonly purged: string[] = [];
  readonly ttls: number[] = [];

  async put(
    _guildId: string,
    messageId: string,
    message: CachedMessage,
    ttlMs: number,
  ): Promise<void> {
    this.stored.set(messageId, message);
    this.ttls.push(ttlMs);
  }

  async get(_guildId: string, messageId: string): Promise<CachedMessage | null> {
    return this.stored.get(messageId) ?? null;
  }

  async getMany(): Promise<Map<string, CachedMessage>> {
    return new Map(this.stored);
  }

  async delete(_guildId: string, messageId: string): Promise<void> {
    this.stored.delete(messageId);
  }

  async purge(guildId: string): Promise<number> {
    this.purged.push(guildId);
    const size = this.stored.size;
    this.stored.clear();
    return size;
  }
}

function provider(config: Record<string, unknown>, enabled = true): ConfigProvider {
  return {
    async get(): Promise<ModuleConfigSnapshot> {
      return { enabled, config: loggingConfigSchema.parse(config) };
    },
  } as unknown as ConfigProvider;
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const bus = { publish: async () => {}, subscribe: () => ({ group: '', close: async () => {} }) };

function build(config: Record<string, unknown>, enabled = true) {
  const cache = new MemoryCache();
  const consumer = new MessageCacheConsumer({
    bus: bus as unknown as EventBus,
    cache,
    config: provider(config, enabled),
    botUserId: BOT,
    logger: silent,
  });

  return { cache, consumer };
}

function created(): ProtonEvent {
  const [event] = normalise(dispatch('messageCreate'));
  if (!event) throw new Error('messageCreate did not normalise');
  return event;
}

const ON = { enabled: true, cacheMessageContent: true };

describe('the message cache consumer', () => {
  test('caches a created message when the guild opted in', async () => {
    const { cache, consumer } = build(ON);

    await consumer.handle(created());

    expect(cache.stored.size).toBe(1);
  });

  test('caches nothing when the guild did not opt in', async () => {
    const { cache, consumer } = build({ enabled: true });

    await consumer.handle(created());

    expect(cache.stored.size).toBe(0);
  });

  test('caches nothing when the module itself is off', async () => {
    const { cache, consumer } = build(ON, false);

    await consumer.handle(created());

    expect(cache.stored.size).toBe(0);
  });

  test('never caches Proton’s own messages', async () => {
    const { cache, consumer } = build(ON);
    const own = created();
    (own.payload as { author: { id: string } }).author.id = BOT;

    await consumer.handle(own);

    expect(cache.stored.size).toBe(0);
  });

  test('respects the module’s ignored channels', async () => {
    const event = created();
    const channelId = (event.payload as { channel_id: string }).channel_id;
    const { cache, consumer } = build({ ...ON, ignoredChannels: [channelId] });

    await consumer.handle(event);

    expect(cache.stored.size).toBe(0);
  });

  test('uses the configured retention', async () => {
    const { cache, consumer } = build({ ...ON, cacheRetention: '2h' });

    await consumer.handle(created());

    expect(cache.ttls).toEqual([2 * 60 * 60 * 1000]);
  });

  test('leaving a guild purges everything remembered for it', async () => {
    const { cache, consumer } = build(ON);
    await consumer.handle(created());

    await consumer.handle({
      id: 'guild.unavailable:1',
      type: 'guild.unavailable',
      guildId: GUILD,
      occurredAt: 0,
      payload: { id: GUILD },
    });

    expect(cache.purged).toEqual([GUILD]);
    expect(cache.stored.size).toBe(0);
  });

  test('switching the option off purges rather than merely stopping', async () => {
    const cache = new MemoryCache();
    const consumer = new MessageCacheConsumer({
      bus: bus as unknown as EventBus,
      cache,
      config: provider({ enabled: true, cacheMessageContent: false }),
      botUserId: BOT,
      logger: silent,
    });

    await consumer.handle({
      id: 'proton.config_changed:1',
      type: 'proton.config_changed',
      guildId: GUILD,
      occurredAt: 0,
      payload: { guildId: GUILD, moduleId: 'logging', changedKeys: ['cacheMessageContent'] },
    });

    expect(cache.purged).toEqual([GUILD]);
  });

  test('a config change to another module leaves the cache alone', async () => {
    const { cache, consumer } = build(ON);

    await consumer.handle({
      id: 'proton.config_changed:2',
      type: 'proton.config_changed',
      guildId: GUILD,
      occurredAt: 0,
      payload: { guildId: GUILD, moduleId: 'serverlog', changedKeys: ['cacheMessageContent'] },
    });

    expect(cache.purged).toEqual([]);
  });

  test('turning the option back on does not purge', async () => {
    const { cache, consumer } = build(ON);

    await consumer.handle({
      id: 'proton.config_changed:3',
      type: 'proton.config_changed',
      guildId: GUILD,
      occurredAt: 0,
      payload: { guildId: GUILD, moduleId: 'logging', changedKeys: ['cacheMessageContent'] },
    });

    expect(cache.purged).toEqual([]);
  });
});

describe('ttlOf', () => {
  test('reads the configured duration', () => {
    expect(ttlOf(loggingConfigSchema.parse({ cacheRetention: '3h' }))).toBe(3 * 60 * 60 * 1000);
  });

  test('falls back rather than throwing on an unreadable duration', () => {
    const config = loggingConfigSchema.parse({});
    expect(ttlOf({ ...config, cacheRetention: 'not a duration' })).toBe(24 * 60 * 60 * 1000);
  });
});
