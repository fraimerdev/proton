import { describe, expect, test } from 'bun:test';
import type { EventBus, Logger, ProtonEvent } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import {
  type BufferedMessage,
  type MessageHistoryBuffer,
  moderationConfigSchema,
  type ReportStore,
} from '@proton/module-moderation';
import type { z } from 'zod';
import {
  MODERATION_MESSAGES_GROUP,
  ModerationMessagesConsumer,
} from '../src/moderation-messages.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const REPORTS = '500000000000000077';
const ARCHIVE = '500000000000000078';
const CARD = '1400000000000000555';
const SENT_AT = Date.parse('2026-08-14T09:01:00.000Z');

class MemoryHistory implements MessageHistoryBuffer {
  readonly recorded: BufferedMessage[] = [];
  readonly deleted: string[] = [];
  readonly purged: string[] = [];

  async record(_guildId: string, message: BufferedMessage): Promise<void> {
    this.recorded.push(message);
  }

  async markDeleted(_guildId: string, channelId: string, messageId: string): Promise<void> {
    this.deleted.push(`${channelId}:${messageId}`);
  }

  async recent(): Promise<BufferedMessage[]> {
    return this.recorded;
  }

  async purge(guildId: string): Promise<void> {
    this.purged.push(guildId);
  }
}

function cardStore(channelId: string) {
  const marked: Array<{ id: string; state: string }> = [];
  const events: string[] = [];
  const report = { id: 'Xk3P9aQ', guildId: GUILD, card: { channelId, messageId: CARD } };

  const lookedUp: string[] = [];

  const store = {
    byCardMessage: async (_guildId: string, messageId: string) => {
      lookedUp.push(messageId);
      return messageId === CARD ? report : null;
    },
    markCard: async (_guildId: string, id: string, state: string) => {
      if (marked.some((mark) => mark.id === id && mark.state === state)) return null;
      marked.push({ id, state });
      return { ...report, card: { ...report.card, state } };
    },
    recordEvent: async (event: { id: string }) => {
      events.push(event.id);
    },
  };

  return { store: store as unknown as ReportStore, marked, events, lookedUp };
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const bus = { publish: async () => {}, subscribe: () => ({ group: '', close: async () => {} }) };

interface Built {
  consumer: ModerationMessagesConsumer;
  history: MemoryHistory;
  invalidated: string[];
}

function build(
  input: z.input<typeof moderationConfigSchema> | 'unreadable',
  options: { enabled?: boolean; reports?: ReportStore } = {},
): Built {
  const history = new MemoryHistory();
  const invalidated: string[] = [];

  const config: ConfigProvider = {
    async get(): Promise<ModuleConfigSnapshot> {
      if (input === 'unreadable') throw new Error('api returned 503');
      return { enabled: options.enabled ?? true, config: moderationConfigSchema.parse(input) };
    },
    invalidate: (guildId, moduleId) => invalidated.push(`${guildId}:${moduleId}`),
  };

  const consumer = new ModerationMessagesConsumer({
    bus: bus as unknown as EventBus,
    config,
    history,
    ...(options.reports ? { reports: options.reports } : {}),
    logger: silent,
    now: () => SENT_AT + 60_000,
  });

  return { consumer, history, invalidated };
}

function created(): ProtonEvent {
  const [event] = normalise(dispatch('messageCreate'));
  if (!event) throw new Error('messageCreate did not normalise');
  return event;
}

function deleted(channelId: string, messageId: string): ProtonEvent {
  return {
    id: `message.deleted:${messageId}`,
    type: 'message.deleted',
    guildId: GUILD,
    occurredAt: SENT_AT,
    payload: { id: messageId, channel_id: channelId, guild_id: GUILD },
  };
}

function bulkDeleted(channelId?: string, ids?: string[]): ProtonEvent {
  const raw = dispatch('messageDeleteBulk');
  if (channelId) raw.d.channel_id = channelId;
  if (ids) raw.d.ids = ids;
  const [event] = normalise(raw);
  if (!event) throw new Error('messageDeleteBulk did not normalise');
  return event;
}

function configChanged(moduleId = 'moderation'): ProtonEvent {
  return {
    id: `proton.config_changed:${moduleId}`,
    type: 'proton.config_changed',
    guildId: GUILD,
    occurredAt: SENT_AT,
    payload: {
      auditId: 'audit-1',
      guildId: GUILD,
      moduleId,
      actorId: '100000000000000001',
      source: 'dashboard',
      enabledBefore: true,
      enabledAfter: true,
      changedKeys: ['punish'],
    },
  };
}

const HISTORY_ON = { punish: { messageHistory: true } };

describe('the moderation messages consumer', () => {
  test('reads its own consumer group, not a module listener group', () => {
    expect(MODERATION_MESSAGES_GROUP).toBe('moderation-messages');
  });

  test('buffers a member’s message while case message history is on', async () => {
    const { consumer, history } = build(HISTORY_ON);

    await consumer.handle(created());

    expect(history.recorded.map((message) => message.content)).toEqual(['hello world']);
  });

  test('buffers nothing while case message history is off, the default', async () => {
    const { consumer, history } = build({});

    await consumer.handle(created());

    expect(history.recorded).toEqual([]);
  });

  test('buffers nothing while Moderation is off', async () => {
    const off = build({ ...HISTORY_ON, enabled: false });
    const disabled = build(HISTORY_ON, { enabled: false });

    await off.consumer.handle(created());
    await disabled.consumer.handle(created());

    expect([...off.history.recorded, ...disabled.history.recorded]).toEqual([]);
  });

  test('marks a buffered message deleted', async () => {
    const { consumer, history } = build(HISTORY_ON);

    await consumer.handle(deleted(CHANNEL, '1400000000000000001'));

    expect(history.deleted).toEqual([`${CHANNEL}:1400000000000000001`]);
  });

  test('purges the buffer when a save leaves history off', async () => {
    const { consumer, history, invalidated } = build({});

    await consumer.handle(configChanged());

    expect(invalidated).toEqual([`${GUILD}:moderation`]);
    expect(history.purged).toEqual([GUILD]);
  });

  test('keeps the buffer when a save leaves history on', async () => {
    const { consumer, history } = build(HISTORY_ON);

    await consumer.handle(configChanged());

    expect(history.purged).toEqual([]);
  });

  test('purges when the saved settings cannot be read', async () => {
    const { consumer, history } = build('unreadable');

    await consumer.handle(configChanged());

    expect(history.purged).toEqual([GUILD]);
  });

  test('ignores another module’s save', async () => {
    const { consumer, history } = build({});

    await consumer.handle(configChanged('logging'));

    expect(history.purged).toEqual([]);
  });

  test('purges the buffer when the server goes unavailable', async () => {
    const { consumer, history } = build(HISTORY_ON);

    await consumer.handle({
      id: 'guild.unavailable:1',
      type: 'guild.unavailable',
      guildId: GUILD,
      occurredAt: SENT_AT,
      payload: { id: GUILD },
    });

    expect(history.purged).toEqual([GUILD]);
  });

  test('marks a staff card missing when it is deleted from the report channel', async () => {
    const cards = cardStore(REPORTS);
    const { consumer } = build({ reports: { channelId: REPORTS } }, { reports: cards.store });

    await consumer.handle(deleted(REPORTS, CARD));

    expect(cards.marked).toEqual([{ id: 'Xk3P9aQ', state: 'missing' }]);
    expect(cards.events).toEqual([`Xk3P9aQ:card_missing:${CARD}`]);
  });

  test('watches the closing archive channels too', async () => {
    const cards = cardStore(ARCHIVE);
    const { consumer } = build(
      {
        reports: {
          channelId: REPORTS,
          closing: { accepted: { mode: 'move', channelId: ARCHIVE } },
        },
      },
      { reports: cards.store },
    );

    await consumer.handle(deleted(ARCHIVE, CARD));

    expect(cards.marked).toHaveLength(1);
  });

  test('never looks up deletions outside the report and archive channels', async () => {
    const cards = cardStore(CHANNEL);
    const { consumer } = build({ reports: { channelId: REPORTS } }, { reports: cards.store });

    await consumer.handle(deleted(CHANNEL, CARD));

    expect(cards.marked).toEqual([]);
  });
});

describe('a bulk delete', () => {
  test('the consumer subscribes to it', () => {
    const groups: Array<{ group: string; types: string[] }> = [];
    const recording = new ModerationMessagesConsumer({
      bus: {
        publish: async () => {},
        subscribe: (group: string, types: string[]) => {
          groups.push({ group, types });
          return { group, close: async () => {} };
        },
      } as unknown as EventBus,
      config: { get: async () => ({ enabled: true, config: {} }) },
      history: new MemoryHistory(),
      logger: silent,
    });

    recording.start();

    expect(groups[0]?.types).toContain('message.bulk_deleted');
  });

  test('marks every buffered message it removed as deleted', async () => {
    const { consumer, history } = build(HISTORY_ON);

    await consumer.handle(bulkDeleted());

    expect(history.deleted).toEqual([
      `${CHANNEL}:1400000000000000003`,
      `${CHANNEL}:1400000000000000001`,
      `${CHANNEL}:1400000000000000002`,
    ]);
  });

  test('marks nothing while case message history is off', async () => {
    const { consumer, history } = build({});

    await consumer.handle(bulkDeleted());

    expect(history.deleted).toEqual([]);
  });

  test('a purge of the report channel marks the staff card missing, once', async () => {
    const cards = cardStore(REPORTS);
    const { consumer } = build({ reports: { channelId: REPORTS } }, { reports: cards.store });
    const purge = bulkDeleted(REPORTS, ['1400000000000000009', CARD]);

    await consumer.handle(purge);
    await consumer.handle(purge);

    expect(cards.marked).toEqual([{ id: 'Xk3P9aQ', state: 'missing' }]);
    expect(cards.events).toEqual([`Xk3P9aQ:card_missing:${CARD}`]);
  });

  test('ids outside the report and archive channels never reach the report store', async () => {
    const cards = cardStore(CHANNEL);
    const { consumer } = build({ reports: { channelId: REPORTS } }, { reports: cards.store });

    await consumer.handle(bulkDeleted(CHANNEL, [CARD]));

    expect(cards.lookedUp).toEqual([]);
    expect(cards.marked).toEqual([]);
  });

  test('a payload that is not a bulk delete is ignored', async () => {
    const { consumer, history } = build(HISTORY_ON);

    await consumer.handle({ ...bulkDeleted(), payload: { ids: 'nope', channel_id: CHANNEL } });

    expect(history.deleted).toEqual([]);
  });
});

describe('the worker starts the consumer', () => {
  test('index.ts subscribes it next to the message cache', async () => {
    const source = await Bun.file(`${import.meta.dir}/../src/index.ts`).text();

    expect(source).toContain('moderationMessagesConsumer.start()');
  });
});
