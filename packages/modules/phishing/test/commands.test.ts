import { describe, expect, test } from 'bun:test';
import { type CommandContext, createCommandOptions } from '@proton/core';
import { createPhishingStatusCommand } from '../src/commands.ts';
import type { PhishingConfig } from '../src/config.ts';
import type { PhishingDeps } from '../src/deps.ts';
import { BOT, CHANNEL, context, MemoryBlocklistStore, type RecordingExecutor } from './harness.ts';

interface CommandHarness {
  ctx: CommandContext<PhishingConfig>;
  executor: RecordingExecutor;
}

function commandContext(config: Partial<PhishingConfig> = {}): CommandHarness {
  const harness = context(config);
  return {
    executor: harness.executor,
    ctx: {
      ...harness.ctx,
      channelId: CHANNEL,
      userId: '400000000000000002',
      options: createCommandOptions([]),
      interaction: { id: '700000000000000001', token: 'tok' },
      idempotencyKey: 'interaction.command:700000000000000001',
    },
  };
}

async function run(deps: PhishingDeps, config: Partial<PhishingConfig> = {}): Promise<string> {
  const harness = commandContext(config);
  await createPhishingStatusCommand(deps).handler(harness.ctx);
  const payload = harness.executor.of('interaction_reply')?.payload as { content: string };
  return payload.content;
}

describe('/phishing', () => {
  test('reports the size of the loaded list', async () => {
    const store = new MemoryBlocklistStore();
    await store.replace({
      domains: ['evil.com', 'worse.net'],
      refreshedAt: new Date(Date.now() - 60_000),
      feeds: ['https://feed-a.test/list.json'],
      failures: [],
    });

    const content = await run({ blocklist: store, botUserId: BOT });

    expect(content).toContain('2 domains');
    expect(content).toContain('1 feed');
  });

  test('says plainly when nothing is loaded, and that it is not a server setting', async () => {
    const content = await run({ blocklist: new MemoryBlocklistStore(), botUserId: BOT });

    expect(content).toContain('No blocklist is loaded');
    expect(content).toContain('not');
    expect(content).toContain('setting in this server');
  });

  test('carries the feed failure through from the last refresh', async () => {
    const store = new MemoryBlocklistStore();
    await store.replace({
      domains: ['evil.com'],
      refreshedAt: new Date(),
      feeds: ['https://feed-a.test/list.json'],
      failures: [{ url: 'https://feed-b.test/list.json', reason: 'HTTP 503' }],
    });

    const content = await run({ blocklist: store, botUserId: BOT });

    expect(content).toContain('feed-b.test');
    expect(content).toContain('503');
  });

  test('names the port and the constructor when nothing is bound', async () => {
    const content = await run({});

    expect(content).toContain('RedisBlocklistStore');
    expect(content).toContain('createPhishingModule');
  });

  test('answers even when the cache read throws', async () => {
    const store = new MemoryBlocklistStore();
    store.stats = async () => {
      throw new Error('Connection is closed.');
    };

    const content = await run({ blocklist: store, botUserId: BOT });
    expect(content).toContain('Connection is closed.');
  });

  test('replies ephemerally — this is server health, not an announcement', async () => {
    const harness = commandContext();
    await createPhishingStatusCommand({
      blocklist: new MemoryBlocklistStore(),
      botUserId: BOT,
    }).handler(harness.ctx);

    const payload = harness.executor.of('interaction_reply')?.payload as { ephemeral: boolean };
    expect(payload.ephemeral).toBe(true);
  });
});
