import type { ActionExecutor, Logger, ModuleContext, ProtonEvent } from '@proton/core';
import type { LoggingConfig } from '../src/config.ts';
import { loggingDefaultConfig } from '../src/config.ts';
import { partitionName } from '../src/partitions.ts';
import type { MessageLogEntry, MessageLogStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const CHANNEL = '500000000000000001';
export const OTHER_CHANNEL = '500000000000000002';
export const AUTHOR = '400000000000000001';
export const MESSAGE = '600000000000000001';

/** 2026-08-14T13:45:12Z — a fixed instant, so partition names are assertable. */
export const OCCURRED_AT = Date.parse('2026-08-14T13:45:12.000Z');

/**
 * An in-memory store with the same dedupe rule as the Postgres one: a second
 * write of the same entry id is ignored, exactly as `ON CONFLICT DO NOTHING`
 * would ignore it. A memory store that happily accepted duplicates would let a
 * redelivery test pass here and fail in production.
 */
export class MemoryMessageLogStore implements MessageLogStore {
  readonly appended: MessageLogEntry[] = [];
  readonly partitions = new Set<string>();
  readonly dropped: string[] = [];

  async append(entries: readonly MessageLogEntry[]): Promise<number> {
    let written = 0;
    for (const entry of entries) {
      if (this.appended.some((existing) => existing.id === entry.id)) continue;
      this.appended.push(entry);
      written++;
    }
    return written;
  }

  async ensurePartition(day: Date): Promise<void> {
    this.partitions.add(partitionName(day));
  }

  async listPartitions(): Promise<string[]> {
    return [...this.partitions].sort();
  }

  async dropPartitions(names: readonly string[]): Promise<void> {
    for (const name of names) {
      this.partitions.delete(name);
      this.dropped.push(name);
    }
  }
}

export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * An executor that fails the test if it is touched.
 *
 * Logging changes nothing in Discord, so it has no business building an
 * `ActionRequest`. Making that an assertion rather than a comment means a future
 * "just post the log to a channel" edit has to be a deliberate decision about
 * I1, not an accident.
 */
const forbiddenExecutor: ActionExecutor = {
  async execute() {
    throw new Error('the logging module must not call the ActionExecutor: it changes no state');
  },
};

export function context(
  config: Partial<LoggingConfig> = {},
): ModuleContext<LoggingConfig> & { logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  return {
    guildId: GUILD,
    config: { ...loggingDefaultConfig, ...config },
    executor: forbiddenExecutor,
    logger,
    logs,
  };
}

interface EventOverrides {
  id?: string;
  guildId?: string | null;
  occurredAt?: number;
  payload?: Record<string, unknown>;
}

function event(
  type: ProtonEvent['type'],
  naturalKey: string,
  payload: Record<string, unknown>,
  overrides: EventOverrides,
): ProtonEvent {
  return {
    // Same shape the gateway derives: deterministic, so a redelivery reuses it.
    id: overrides.id ?? `${type}:${naturalKey}`,
    type,
    guildId: overrides.guildId === undefined ? GUILD : overrides.guildId,
    occurredAt: overrides.occurredAt ?? OCCURRED_AT,
    payload: { ...payload, ...overrides.payload },
  };
}

export function messageUpdated(overrides: EventOverrides = {}): ProtonEvent {
  return event(
    'message.updated',
    MESSAGE,
    {
      id: MESSAGE,
      channel_id: CHANNEL,
      guild_id: GUILD,
      author: { id: AUTHOR },
      content: 'the edited text',
      edited_timestamp: '2026-08-14T13:45:12.000Z',
    },
    overrides,
  );
}

export function messageDeleted(overrides: EventOverrides = {}): ProtonEvent {
  return event(
    'message.deleted',
    MESSAGE,
    { id: MESSAGE, channel_id: CHANNEL, guild_id: GUILD },
    overrides,
  );
}

export function messageBulkDeleted(ids: string[], overrides: EventOverrides = {}): ProtonEvent {
  return event(
    'message.bulk_deleted',
    ids.join(','),
    { ids, channel_id: CHANNEL, guild_id: GUILD },
    overrides,
  );
}
