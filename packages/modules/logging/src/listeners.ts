import type { EventListener, EventType, MessageContentCache } from '@proton/core';
import type { LoggingConfig } from './config.ts';
import { messageIdsOf, toMessageLogEntries } from './events.ts';
import type { MessageLogStore } from './store.ts';

export const LOGGED_EVENT_TYPES: EventType[] = [
  'message.updated',
  'message.deleted',
  'message.bulk_deleted',
];

export interface LoggingDeps {
  store?: MessageLogStore;
  cache?: MessageContentCache;
}

const UNBOUND_STORE =
  'Message logging is enabled for this guild but no message log store is bound, so no edits ' +
  'or deletions are being recorded. The process running modules must construct ' +
  'PostgresMessageLogStore(dbHandle) and pass it to createLoggingModule({ store }).';

export function createMessageLogListener(deps: LoggingDeps): EventListener<LoggingConfig> {
  return {
    types: LOGGED_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      // Ids are resolved here rather than inside toMessageLogEntries so that function stays pure
      // and testable with a hand-built Map.
      const cached =
        deps.cache && ctx.config.cacheMessageContent
          ? await deps.cache.getMany(ctx.guildId, messageIdsOf(event))
          : undefined;

      const entries = toMessageLogEntries(event, ctx.config, cached);
      if (entries.length === 0) return;

      if (!deps.store) {
        ctx.logger.error(UNBOUND_STORE, { guildId: ctx.guildId, moduleId: 'logging' });
        return;
      }

      const written = await deps.store.append(entries);

      if (written < entries.length) {
        ctx.logger.info('message log entries already recorded', {
          guildId: ctx.guildId,
          eventId: event.id,
          skipped: entries.length - written,
        });
      }
    },
  };
}
