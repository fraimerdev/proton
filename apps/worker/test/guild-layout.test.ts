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
    // Round-tripped through JSON exactly as Redis would, so a field that does
    // not survive serialisation fails here rather than in production.
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
    const event = normalise(dispatch('guildCreate'));

    await consumer.handle(event as NonNullable<typeof event>);

    const layout = await store.get(GUILD);
    expect(layout?.guildId).toBe(GUILD);
    expect(layout?.source).toBe('gateway');
    expect(layout?.channels.length).toBeGreaterThan(0);
  });

  /**
   * The reason this consumer exists at all, asserted end to end.
   *
   * `GuildStateStore` looks like it should serve backups and must not: it reduces
   * a guild to what the I8 prechecks decide on and throws away `flags`. A backup
   * built from it would record every hidden channel as `obfuscated: false` under
   * a `source: 'gateway'` claim — a lie the restore planner cannot detect,
   * discovered only after a server has been nuked (§10.1).
   *
   * So this goes fixture → normaliser → consumer → store → snapshot, and asserts
   * the flag is still there at the far end. Any future "keep only the fields we
   * use" change to the consumer fails here.
   */
  test('an obfuscated channel survives the round trip with its flag intact', async () => {
    const { consumer, store } = build();
    const event = normalise(dispatch('channelObfuscated'));

    await consumer.handle(event as NonNullable<typeof event>);
    const layout = await store.get(GUILD);
    const captured = buildSnapshot(layout as GuildLayout, 1_770_000_000_000);

    const hidden = captured.snapshot.channels.find((c) => c.id === HIDDEN_CHANNEL);
    expect(hidden?.obfuscated).toBe(true);
    // Marked, not omitted: the channel is in the snapshot as a placeholder so the
    // count is honest, with nothing truthful to put in its name.
    expect(hidden?.name).toBeNull();

    const visible = captured.snapshot.channels.find((c) => c.id === '500000000000000001');
    expect(visible?.obfuscated).toBe(false);
    expect(visible?.name).toBe('general');
  });

  /** §10.1 requires the admin to be told at *backup* time, not at restore time. */
  test('the capture report names the hidden channels a human has to know about', async () => {
    const { consumer, store } = build();

    await consumer.handle(normalise(dispatch('channelObfuscated')) as never);
    const captured = buildSnapshot((await store.get(GUILD)) as GuildLayout, 1_770_000_000_000);

    expect(captured.report.obfuscatedChannelIds).toEqual([HIDDEN_CHANNEL]);

    // The sentence an admin actually reads has to name the channel and the
    // permission — "1 channel was skipped" would send them hunting.
    const said = describeCapture(captured.report).join('\n');
    expect(said).toContain(`<#${HIDDEN_CHANNEL}>`);
    expect(said).toContain('View Channel');
  });

  test('a guild the bot was removed from has its layout dropped', async () => {
    const { consumer, store } = build();
    await consumer.handle(normalise(dispatch('guildCreate')) as never);

    await consumer.handle({
      type: 'guild.unavailable',
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: { id: GUILD },
    });

    expect(await store.get(GUILD)).toBeNull();
  });

  /**
   * A GUILD_DELETE carrying `unavailable: true` is a Discord outage, not a
   * removal — the bot is still a member and the guild is coming back. Dropping
   * the layout would mean backups silently stop working until the next connect.
   */
  test('an outage does not drop the layout', async () => {
    const { consumer, store } = build();
    await consumer.handle(normalise(dispatch('guildCreate')) as never);

    await consumer.handle({
      type: 'guild.unavailable',
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: { id: GUILD, unavailable: true },
    });

    expect(await store.get(GUILD)).not.toBeNull();
  });

  /**
   * An empty layout would produce a confidently empty backup — "0 channels" reads
   * exactly like a healthy tiny server, so it has to be loud.
   */
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

  /**
   * There is one Redis stream per event type and XREADGROUP returns per-stream
   * batches in key order, not in timestamp order — so on a first deploy, which
   * replays the retained history of both streams at once, a removal from last
   * week can arrive after this morning's GUILD_CREATE. Deleting on it would drop
   * the layout of a server the bot is sitting in, and backups would quietly stop
   * working until the next gateway reconnect.
   */
  test('a removal older than the stored layout does not delete it', async () => {
    const { consumer, store, logs } = build();
    const created = normalise(dispatch('guildCreate')) as NonNullable<ReturnType<typeof normalise>>;
    await consumer.handle(created);

    await consumer.handle({
      type: 'guild.unavailable',
      guildId: GUILD,
      // A week before the layout we hold.
      occurredAt: created.occurredAt - 7 * 24 * 60 * 60 * 1000,
      payload: { id: GUILD },
    });

    expect(await store.get(GUILD)).not.toBeNull();
    expect(logs.some((l) => l.message.includes('older than the layout'))).toBe(true);
  });

  test('a stale guild.available does not overwrite a newer layout', async () => {
    const { consumer, store } = build();
    const current = normalise(dispatch('channelObfuscated')) as NonNullable<
      ReturnType<typeof normalise>
    >;
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
