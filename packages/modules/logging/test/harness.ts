import type { ActionExecutor, Logger, ModuleContext, ProtonEvent } from '@proton/core';
import { normalise, type RawDispatch } from '@proton/gateway/normaliser';
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

export const EDITED_AT = '2026-08-14T13:45:12.000Z';

/**
 * Build the event by running a raw dispatch through the **real** normaliser.
 *
 * These used to be hand-written, with ids like `message.updated:<messageId>` and
 * `message.bulk_deleted:<id>,<id>,<id>`. Production emits neither: an update's
 * key carries `edited_timestamp` so successive edits stay distinct, and a bulk
 * delete's is a hashed digest of the sorted id set. So every assertion about a
 * row id was pinning a shape nothing sends, and the whole module was tested
 * against a vocabulary of its own — which is how it shipped a listener wired to
 * three event types the gateway did not emit at all, with a green suite.
 *
 * Going through `normalise` costs a devDependency on `@proton/gateway` and buys
 * the guarantee that if the gateway changes shape, these tests fail rather than
 * quietly describing a past.
 */
function event(
  raw: RawDispatch,
  payload: Record<string, unknown>,
  overrides: EventOverrides,
): ProtonEvent {
  const normalised = normalise({ ...raw, d: { ...raw.d, ...payload } });
  if (!normalised) throw new Error(`the normaliser produced nothing for ${raw.t}`);

  return {
    ...normalised,
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
    ...(overrides.guildId !== undefined ? { guildId: overrides.guildId } : {}),
    occurredAt: overrides.occurredAt ?? OCCURRED_AT,
    payload: { ...(normalised.payload as Record<string, unknown>), ...overrides.payload },
  };
}

export function messageUpdated(overrides: EventOverrides = {}): ProtonEvent {
  return event(
    { t: 'MESSAGE_UPDATE', s: 1, op: 0, d: {} },
    {
      id: MESSAGE,
      channel_id: CHANNEL,
      guild_id: GUILD,
      author: { id: AUTHOR },
      content: 'the edited text',
      edited_timestamp: EDITED_AT,
    },
    overrides,
  );
}

export function messageDeleted(overrides: EventOverrides = {}): ProtonEvent {
  return event(
    { t: 'MESSAGE_DELETE', s: 1, op: 0, d: {} },
    { id: MESSAGE, channel_id: CHANNEL, guild_id: GUILD },
    overrides,
  );
}

export function messageBulkDeleted(ids: string[], overrides: EventOverrides = {}): ProtonEvent {
  return event(
    { t: 'MESSAGE_DELETE_BULK', s: 1, op: 0, d: {} },
    { ids, channel_id: CHANNEL, guild_id: GUILD },
    overrides,
  );
}
