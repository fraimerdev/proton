import { describe, expect, test } from 'bun:test';
import type { ModuleContext, ProtonEvent } from '@proton/core';
import { ProviderRegistry } from '@proton/core';
import { refreshMessage } from '../src/announce.ts';
import {
  handleChannelDeleted,
  handleMessageDeleted,
  readDeletedChannel,
  readDeletedMessages,
} from '../src/cleanup.ts';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const OTHER_CHANNEL = '500000000000000009';
const MESSAGE = '700000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');

interface Harness {
  ctx: ModuleContext<GiveawaysConfig>;
  edits: string[];
  warnings: string[];
}

function harness(enabled = true): Harness {
  const edits: string[] = [];
  const warnings: string[] = [];

  const ctx = {
    guildId: GUILD,
    config: { ...giveawaysConfigSchema.parse({}), enabled },
    tier: 'free',
    executor: {
      async execute(request: { kind: string }) {
        edits.push(request.kind);
        return { status: 'executed' };
      },
    },
    logger: { info() {}, warn: (message: string) => warnings.push(message), error() {} },
  } as unknown as ModuleContext<GiveawaysConfig>;

  return { ctx, edits, warnings };
}

function event(type: string, payload: unknown): ProtonEvent {
  return { id: 'e1', type, guildId: GUILD, payload } as unknown as ProtonEvent;
}

async function seeded(over: Partial<CreateGiveawayInput> = {}) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: HOST,
    ...over,
  } satisfies CreateGiveawayInput);

  const deps: GiveawaysDeps = {
    store,
    providers: new ProviderRegistry(),
    now: () => NOW.getTime(),
  };

  return { store, deps };
}

describe('reading deletion payloads', () => {
  test('MESSAGE_DELETE carries a single id', () => {
    expect(readDeletedMessages({ id: MESSAGE, channel_id: CHANNEL })).toEqual([MESSAGE]);
  });

  test('MESSAGE_DELETE_BULK carries a list', () => {
    expect(readDeletedMessages({ ids: ['a', 'b'], channel_id: CHANNEL })).toEqual(['a', 'b']);
  });

  test('a payload with neither yields nothing rather than throwing', () => {
    expect(readDeletedMessages({ channel_id: CHANNEL })).toEqual([]);
    expect(readDeletedMessages(null)).toEqual([]);
  });

  test('a deleted channel is read from id or channel_id', () => {
    expect(readDeletedChannel({ id: CHANNEL })).toBe(CHANNEL);
    expect(readDeletedChannel({ channel_id: CHANNEL })).toBe(CHANNEL);
    expect(readDeletedChannel({})).toBeNull();
  });
});

describe('a deleted giveaway message', () => {
  // Without clearing message_id every later edit 404s forever, and report() swallows each one as
  // a warn, so nothing ever stops trying.
  test('is forgotten so nothing tries to edit it again', async () => {
    const { store, deps } = await seeded();
    const h = harness();

    expect(await handleMessageDeleted(event('message.deleted', { id: MESSAGE }), h.ctx, deps)).toBe(
      'orphaned',
    );

    expect((await store.get(GUILD, 'g1'))?.messageId).toBeNull();
  });

  test('stops refreshMessage from issuing an edit at all', async () => {
    const { store, deps } = await seeded();
    const h = harness();

    await handleMessageDeleted(event('message.deleted', { id: MESSAGE }), h.ctx, deps);

    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('expected the giveaway to survive');

    const edited = await refreshMessage(
      h.ctx,
      { store, providers: new ProviderRegistry() },
      giveaway,
      'k',
    );

    expect(edited).toBe(false);
    expect(h.edits).toHaveLength(0);
  });

  test('keeps the giveaway and its entries', async () => {
    const { store, deps } = await seeded();
    await store.enter({
      giveawayId: 'g1',
      userId: '400000000000000055',
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });

    await handleMessageDeleted(event('message.deleted', { id: MESSAGE }), harness().ctx, deps);

    expect((await store.get(GUILD, 'g1'))?.status).toBe('running');
    expect(await store.entrantCount('g1')).toBe(1);
  });

  test('names the giveaway in the warning so a host can find it', async () => {
    const { deps } = await seeded();
    const h = harness();

    await handleMessageDeleted(event('message.deleted', { id: MESSAGE }), h.ctx, deps);

    expect(h.warnings.join(' ')).toContain('A prize');
  });

  test('a bulk delete that sweeps up the giveaway message is handled too', async () => {
    const { store, deps } = await seeded();

    await handleMessageDeleted(
      event('message.bulk_deleted', { ids: ['x', MESSAGE, 'y'] }),
      harness().ctx,
      deps,
    );

    expect((await store.get(GUILD, 'g1'))?.messageId).toBeNull();
  });

  test('an unrelated message is ignored', async () => {
    const { store, deps } = await seeded();

    expect(
      await handleMessageDeleted(event('message.deleted', { id: 'other' }), harness().ctx, deps),
    ).toBe('ignored');

    expect((await store.get(GUILD, 'g1'))?.messageId).toBe(MESSAGE);
  });

  test('a second delete of the same message is a no-op', async () => {
    const { deps } = await seeded();
    const h = harness();

    await handleMessageDeleted(event('message.deleted', { id: MESSAGE }), h.ctx, deps);

    expect(await handleMessageDeleted(event('message.deleted', { id: MESSAGE }), h.ctx, deps)).toBe(
      'ignored',
    );
  });
});

describe('a deleted channel', () => {
  test('orphans every giveaway posted in it', async () => {
    const { store, deps } = await seeded();
    await store.create({
      id: 'g2',
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: '700000000000000002',
      hostId: HOST,
      title: 'Another prize',
      winnerCount: 1,
      endsAt: new Date(NOW.getTime() + 60_000),
      createdBy: HOST,
    });

    expect(
      await handleChannelDeleted(event('channel.deleted', { id: CHANNEL }), harness().ctx, deps),
    ).toBe('orphaned');

    expect((await store.get(GUILD, 'g1'))?.messageId).toBeNull();
    expect((await store.get(GUILD, 'g2'))?.messageId).toBeNull();
  });

  test('leaves giveaways in other channels alone', async () => {
    const { store, deps } = await seeded();

    await handleChannelDeleted(
      event('channel.deleted', { id: OTHER_CHANNEL }),
      harness().ctx,
      deps,
    );

    expect((await store.get(GUILD, 'g1'))?.messageId).toBe(MESSAGE);
  });

  test('preserves the giveaway records rather than deleting them', async () => {
    const { store, deps } = await seeded();

    await handleChannelDeleted(event('channel.deleted', { id: CHANNEL }), harness().ctx, deps);

    expect(await store.get(GUILD, 'g1')).not.toBeNull();
  });

  test('a channel with no giveaways is ignored', async () => {
    const { deps } = await seeded();

    expect(
      await handleChannelDeleted(event('channel.deleted', { id: 'nothing' }), harness().ctx, deps),
    ).toBe('ignored');
  });

  test('does not crash when the store is unbound', async () => {
    expect(
      await handleChannelDeleted(event('channel.deleted', { id: CHANNEL }), harness().ctx, {}),
    ).toBe('ignored');
  });
});
