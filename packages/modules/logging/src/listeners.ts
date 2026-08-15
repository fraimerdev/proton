import type { EventListener, EventType } from '@proton/core';
import type { LoggingConfig } from './config.ts';
import { toMessageLogEntries } from './events.ts';
import type { MessageLogStore } from './store.ts';

/** The three dispatches this module exists for (PLAN.md §4-P1 names them all). */
export const LOGGED_EVENT_TYPES: EventType[] = [
  'message.updated',
  'message.deleted',
  'message.bulk_deleted',
];

export interface LoggingDeps {
  /**
   * Where logs are written.
   *
   * Optional only because nothing in the framework can supply it yet — see the
   * blockers on `createLoggingModule`. A module built without one still
   * registers, still renders its config, and says loudly what is missing the
   * first time a guild that opted in produces an event.
   */
  store?: MessageLogStore;
}

const UNBOUND_STORE =
  'Message logging is enabled for this guild but no message log store is bound, so no edits ' +
  'or deletions are being recorded. The process running modules must construct ' +
  'PostgresMessageLogStore(dbHandle) and pass it to createLoggingModule({ store }).';

/**
 * The listener that writes message logs.
 *
 * It never calls `ctx.executor`, because logging changes nothing in Discord —
 * I1 governs state changes, and there is none here. What it does have to honour
 * is I4: every entry carries an id derived from the originating dispatch, so the
 * store's insert is a no-op on redelivery rather than a duplicate row.
 */
export function createMessageLogListener(deps: LoggingDeps): EventListener<LoggingConfig> {
  return {
    types: LOGGED_EVENT_TYPES,

    async handler(event, ctx) {
      // The opt-in gate, checked before the payload is even read: a guild that
      // has not turned this on must not have its message content touched, not
      // even in memory.
      if (!ctx.config.enabled) return;

      const entries = toMessageLogEntries(event, ctx.config);
      if (entries.length === 0) return;

      if (!deps.store) {
        ctx.logger.error(UNBOUND_STORE, { guildId: ctx.guildId, moduleId: 'logging' });
        return;
      }

      const written = await deps.store.append(entries);

      // Deduped redeliveries are the expected case after a gateway RESUME, not a
      // fault — worth a line at info so a quiet log is distinguishable from a
      // broken one, but never a warning.
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
