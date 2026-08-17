import { describe, expect, test } from 'bun:test';
import type { Logger } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { buildSnapshot, describeCapture, type GuildLayout } from '@proton/module-backup';
import {
  GuildLayoutConsumer,
  type GuildLayoutStore,
  guildLayoutKey,
  type StoredGuildLayout,
} from '../src/guild-layout.ts';

const GUILD = '900000000000000001';
const HIDDEN_CHANNEL = '500000000000000002';

class MemoryLayoutStore implements GuildLayoutStore {
  readonly layouts = new Map<string, StoredGuildLayout>();

  async get(guildId: string): Promise<StoredGuildLayout | null> {
    return this.layouts.get(guildId) ?? null;
  }

  async put(layout: StoredGuildLayout): Promise<void> {
    this.layouts.set(layout.guildId, JSON.parse(JSON.stringify(layout)) as StoredGuildLayout);
  }

  async delete(guildId: string): Promise<void> {
    this.layouts.delete(guildId);
  }
}

function build(): {
  consumer: GuildLayoutConsumer;
  store: MemoryLayoutStore;
  logs: Array<{ level: string; message: string }>;
} {
  const store = new MemoryLayoutStore();
  const logs: Array<{ level: string; message: string }> = [];
  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  return {
    store,
    logs,
    consumer: new GuildLayoutConsumer({
      bus: {
        publish: async () => undefined,
        subscribe: (group) => ({ group, close: async () => undefined }),
      },
      store,
      logger,
    }),
  };
}

describe('GuildLayoutConsumer', () => {
  test('stores the channels and roles from guild.available', async () => {
    const { consumer, store } = build();
    const event = normalise(dispatch('guildCreate'))[0];

    await consumer.handle(event as NonNullable<typeof event>);

    const layout = await store.get(GUILD);
    expect(layout?.guildId).toBe(GUILD);
    expect(layout?.source).toBe('gateway');
    expect(layout?.channels.length).toBeGreaterThan(0);
  });

  test('an obfuscated channel survives the round trip with its flag intact', async () => {
    const { consumer, store } = build();
    const event = normalise(dispatch('channelObfuscated'))[0];

    await consumer.handle(event as NonNullable<typeof event>);
    const layout = await store.get(GUILD);
    const captured = buildSnapshot(layout as GuildLayout, 1_770_000_000_000);

    const hidden = captured.snapshot.channels.find((c) => c.id === HIDDEN_CHANNEL);
    expect(hidden?.obfuscated).toBe(true);

    expect(hidden?.name).toBeNull();

    const visible = captured.snapshot.channels.find((c) => c.id === '500000000000000001');
    expect(visible?.obfuscated).toBe(false);
    expect(visible?.name).toBe('general');
  });

  test('the capture report names the hidden channels a human has to know about', async () => {
    const { consumer, store } = build();

    await consumer.handle(normalise(dispatch('channelObfuscated'))[0] as never);
    const captured = buildSnapshot((await store.get(GUILD)) as GuildLayout, 1_770_000_000_000);

    expect(captured.report.obfuscatedChannelIds).toEqual([HIDDEN_CHANNEL]);

    const said = describeCapture(captured.report).join('\n');
    expect(said).toContain(`<#${HIDDEN_CHANNEL}>`);
    expect(said).toContain('View Channel');
  });

  test('a guild the bot was removed from has its layout dropped', async () => {
    const { consumer, store } = build();
    await consumer.handle(normalise(dispatch('guildCreate'))[0] as never);

    await consumer.handle({
      type: 'guild.unavailable',
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: { id: GUILD },
    });

    expect(await store.get(GUILD)).toBeNull();
  });

  test('an outage does not drop the layout', async () => {
    const { consumer, store } = build();
    await consumer.handle(normalise(dispatch('guildCreate'))[0] as never);

    await consumer.handle({
      type: 'guild.unavailable',
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: { id: GUILD, unavailable: true },
    });

    expect(await store.get(GUILD)).not.toBeNull();
  });

  test('a payload with no channels or roles is refused, loudly', async () => {
    const { consumer, store, logs } = build();

    await consumer.handle({
      type: 'guild.available',
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: { id: GUILD, channels: [], roles: [] },
    });

    expect(await store.get(GUILD)).toBeNull();
    expect(logs[0]?.level).toBe('warn');
    expect(logs[0]?.message).toContain('Backups taken now would be empty');
  });

  test('a removal older than the stored layout does not delete it', async () => {
    const { consumer, store, logs } = build();
    const [created] = normalise(dispatch('guildCreate'));
    if (!created) throw new Error('guildCreate did not normalise');
    await consumer.handle(created);

    await consumer.handle({
      type: 'guild.unavailable',
      guildId: GUILD,

      occurredAt: created.occurredAt - 7 * 24 * 60 * 60 * 1000,
      payload: { id: GUILD },
    });

    expect(await store.get(GUILD)).not.toBeNull();
    expect(logs.some((l) => l.message.includes('older than the layout'))).toBe(true);
  });

  test('a stale guild.available does not overwrite a newer layout', async () => {
    const { consumer, store } = build();
    const [current] = normalise(dispatch('channelObfuscated'));
    if (!current) throw new Error('channelObfuscated did not normalise');
    await consumer.handle(current);

    await consumer.handle({
      type: 'guild.available',
      guildId: GUILD,
      occurredAt: current.occurredAt - 60_000,
      payload: { id: GUILD, channels: [{ id: 'stale', type: 0 }], roles: [] },
    });

    const layout = await store.get(GUILD);
    expect(layout?.capturedAt).toBe(current.occurredAt);
    expect(layout?.channels).toHaveLength(2);
  });

  test('keys are namespaced per guild', () => {
    expect(guildLayoutKey(GUILD)).toBe(`proton:layout:${GUILD}`);
  });
});
