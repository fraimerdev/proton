import { describe, expect, test } from 'bun:test';
import type { CachedMessage } from '@proton/core';
import { AuditLogEvent } from 'discord-api-types/v10';
import { serverlogDefaultConfig } from '../src/config.ts';
import { createServerlogListener } from '../src/listeners.ts';
import { NOT_CACHED } from '../src/render/messages.ts';
import {
  auditEvent,
  config,
  context,
  EMOJIS,
  event,
  MemoryCorrelationStore,
  RecordingExecutor,
  resolver,
} from './harness.ts';

const MESSAGES_ON = {
  categories: { ...serverlogDefaultConfig.categories, messages: true, voice: true },
};

class MemoryCache {
  readonly stored = new Map<string, CachedMessage>();
  readonly deleted: string[] = [];

  seed(messageId: string, message: CachedMessage): void {
    this.stored.set(messageId, message);
  }

  async get(_guildId: string, messageId: string): Promise<CachedMessage | null> {
    return this.stored.get(messageId) ?? null;
  }

  async getMany(): Promise<Map<string, CachedMessage>> {
    return new Map(this.stored);
  }

  async put(_guildId: string, messageId: string, message: CachedMessage): Promise<void> {
    this.stored.set(messageId, message);
  }

  async delete(_guildId: string, messageId: string): Promise<void> {
    this.deleted.push(messageId);
    this.stored.delete(messageId);
  }

  async purge(): Promise<number> {
    const size = this.stored.size;
    this.stored.clear();
    return size;
  }
}

function cachedMessage(overrides: Partial<CachedMessage> = {}): CachedMessage {
  return {
    authorId: '100000000000000002',
    authorBot: false,
    channelId: '500000000000000001',
    content: 'the original text',
    attachments: [],
    createdAt: Date.parse('2026-08-16T11:00:00.000Z'),
    ...overrides,
  };
}

function build(cache?: MemoryCache) {
  const correlation = new MemoryCorrelationStore();
  const flushes: Array<{ guildId: string; actionType: number; targetId: string }> = [];

  const deps = {
    correlation,
    users: resolver,
    emojis: EMOJIS,
    ...(cache ? { cache } : {}),
    scheduleFlush: async (request: { guildId: string; actionType: number; targetId: string }) => {
      flushes.push(request);
    },
  };

  return { deps, correlation, flushes, listener: createServerlogListener(deps) };
}

function fields(executor: RecordingExecutor): Array<{ name: string; value: string }> {
  const embed = executor.embeds()[0];
  return (embed?.fields ?? []) as Array<{ name: string; value: string }>;
}

describe('message edits', () => {
  test('an edit shows Before and After when the text was remembered', async () => {
    const cache = new MemoryCache();
    cache.seed('1400000000000000001', cachedMessage());

    const { listener } = build(cache);
    const executor = new RecordingExecutor();

    await listener.handler(event('messageUpdate'), context(executor, config(MESSAGES_ON)));

    expect(executor.titles()).toEqual(['Message edited']);
    expect(fields(executor).map((field) => field.name)).toEqual(['Before', 'After']);
    expect(fields(executor)[0]?.value).toBe('the original text');
  });

  test('without the cache the Before field says so instead of lying', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('messageUpdate'), context(executor, config(MESSAGES_ON)));

    expect(fields(executor)[0]?.value).toBe(NOT_CACHED);
  });

  test('the edit refreshes the cache so a second edit shows the first edit’s text', async () => {
    const cache = new MemoryCache();
    cache.seed('1400000000000000001', cachedMessage());

    const { listener } = build(cache);
    await listener.handler(
      event('messageUpdate'),
      context(new RecordingExecutor(), config(MESSAGES_ON)),
    );

    expect(cache.stored.get('1400000000000000001')?.content).not.toBe('the original text');
  });

  test('the log carries a jump link in the owner’s form', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('messageUpdate'), context(executor, config(MESSAGES_ON)));

    expect(String(executor.embeds()[0]?.description)).toContain('[`Jump to`](https://discord.com/');
  });

  test('an edit that changed nothing is not logged', async () => {
    const cache = new MemoryCache();
    const unchanged = event('messageUpdate');
    const content = (unchanged.payload as { content: string }).content;
    cache.seed('1400000000000000001', cachedMessage({ content }));

    const { listener } = build(cache);
    const executor = new RecordingExecutor();

    await listener.handler(unchanged, context(executor, config(MESSAGES_ON)));

    expect(executor.requests).toEqual([]);
  });
});

describe('message deletes', () => {
  test('a delete names the author and the content the cache remembered', async () => {
    const cache = new MemoryCache();
    cache.seed('1400000000000000001', cachedMessage());

    const { deps, listener, flushes } = build(cache);
    const executor = new RecordingExecutor();
    const ctx = context(executor, config(MESSAGES_ON));

    await listener.handler(event('messageDelete'), ctx);

    const pending = flushes[0];
    if (!pending) throw new Error('no flush was scheduled');

    const { flushPending } = await import('../src/listeners.ts');
    await flushPending(deps, ctx, pending);

    expect(executor.titles()).toEqual(['Message deleted']);
    expect(String(executor.embeds()[0]?.description)).toContain('100000000000000002');
    expect(fields(executor)[0]?.value).toBe('the original text');
  });

  test('a moderator delete correlates and names them', async () => {
    const cache = new MemoryCache();
    cache.seed('1400000000000000001', cachedMessage());

    const { listener } = build(cache);
    const executor = new RecordingExecutor();
    const ctx = context(executor, config(MESSAGES_ON));

    await listener.handler(event('messageDelete'), ctx);
    await listener.handler(
      auditEvent(AuditLogEvent.MessageDelete, { target_id: '1400000000000000001' }),
      ctx,
    );

    expect(executor.footers()).toEqual(['admin']);
  });

  test('the cache entry is dropped once the message is gone', async () => {
    const cache = new MemoryCache();
    cache.seed('1400000000000000001', cachedMessage());

    const { listener } = build(cache);
    await listener.handler(
      event('messageDelete'),
      context(new RecordingExecutor(), config(MESSAGES_ON)),
    );

    expect(cache.deleted).toEqual(['1400000000000000001']);
  });
});

describe('bulk deletes', () => {
  test('a purge is one embed with a count, not one embed per message', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('messageDeleteBulk'), context(executor, config(MESSAGES_ON)));

    expect(executor.requests).toHaveLength(1);
    expect(executor.titles()).toEqual(['Messages bulk deleted']);
    expect(String(executor.embeds()[0]?.description)).toContain('3');
  });
});

describe('voice', () => {
  test('joining a channel logs a join', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('voiceStateJoin'), context(executor, config(MESSAGES_ON)));

    expect(executor.titles()).toEqual(['Member joined a voice channel']);
  });

  test('disconnecting logs a leave and not a join', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('voiceStateLeave'), context(executor, config(MESSAGES_ON)));

    expect(executor.titles()).toEqual(['Member left voice']);
  });

  test('a moderator disconnect is its own log with the moderator named', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      auditEvent(AuditLogEvent.MemberDisconnect, { options: { count: '3' } }),
      context(executor, config(MESSAGES_ON)),
    );

    expect(executor.titles()).toEqual(['Members disconnected from voice']);
    expect(executor.footers()).toEqual(['admin']);
  });

  test('voice is off by default, because it is the noisiest category', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('voiceStateJoin'), context(executor, config()));

    expect(executor.requests).toEqual([]);
  });
});
