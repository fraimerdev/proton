import type { DbHandle } from '@proton/db';
import { isPartitionName, partitionName, partitionRange, utcDayStart } from './partitions.ts';
import type { MessageLogEntry, MessageLogStore } from './store.ts';
import { messageLogs, type NewMessageLogRow } from './table.ts';

/** postgres.js hands back raw column names; the aliases satisfy its row bound. */
type PartitionRow = { name: string };
type ExistsRow = { present: boolean };

/** Postgres error codes we interpret rather than propagate. */
const CHECK_VIOLATION = '23514';
const DUPLICATE_TABLE = '42P07';
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps driver failures in a `DrizzleQueryError`, so the SQLSTATE that
 * decides whether a write is recoverable sits on the cause, not on the error
 * that was thrown. Walking the chain rather than reading `.code` is what keeps
 * the missing-partition retry from silently never firing.
 */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * "no partition of relation "message_logs" found for row" — Postgres reports a
 * missing partition as a check violation, and this table has no other check
 * constraint, so the code alone identifies it.
 */
function isMissingPartition(error: unknown): boolean {
  return errorCode(error) === CHECK_VIOLATION;
}

/**
 * Two workers creating the same partition in the same instant.
 *
 * `IF NOT EXISTS` checks and then creates, which is not atomic, so the loser of
 * the race sees a duplicate. The partition it wanted now exists, which is all it
 * asked for.
 */
function isAlreadyCreated(error: unknown): boolean {
  const code = errorCode(error);
  return code === DUPLICATE_TABLE || code === UNIQUE_VIOLATION;
}

function toRow(entry: MessageLogEntry): NewMessageLogRow {
  return {
    id: entry.id,
    guildId: entry.guildId,
    channelId: entry.channelId,
    messageId: entry.messageId,
    authorId: entry.authorId,
    kind: entry.kind,
    contentBefore: entry.contentBefore,
    contentAfter: entry.contentAfter,
    occurredAt: entry.occurredAt,
  };
}

/**
 * Postgres implementation of the message log (PLAN.md §6).
 *
 * Writes go through Drizzle so the timestamp mapping is the one Drizzle installed
 * on the shared client; the partition DDL goes through raw SQL because a table
 * name cannot be a bind parameter. Every identifier that reaches raw SQL is
 * generated from a `Date` and re-checked against `isPartitionName` first.
 */
export class PostgresMessageLogStore implements MessageLogStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  /**
   * Append, creating the day's partition if the write lands in a gap.
   *
   * The maintenance job creates partitions a day ahead, so this retry should
   * never fire — but "should never" is how a logging module ends up silently
   * discarding the first edits after midnight when a job run was missed. Failing
   * a write here loses evidence a guild opted in to keep, so the write repairs
   * the schema and retries once rather than propagating.
   */
  async append(entries: readonly MessageLogEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const values = entries.map(toRow);

    try {
      return await this.#insert(values);
    } catch (error) {
      if (!isMissingPartition(error)) throw error;

      for (const day of distinctDays(entries)) await this.ensurePartition(day);
      return await this.#insert(values);
    }
  }

  async ensurePartition(day: Date): Promise<void> {
    const name = partitionName(day);
    // Checked first so the overwhelmingly common case — the partition is already
    // there — costs one cheap catalogue lookup instead of a DDL statement and the
    // NOTICE Postgres emits with it.
    if (await this.#exists(name)) return;

    const { from, to } = partitionRange(day);

    // Bounds carry an explicit UTC offset, so the partition covers the same
    // instants regardless of the session's TimeZone setting when it was created.
    const statement =
      `create table if not exists "${name}" partition of "message_logs" ` +
      `for values from ('${from.toISOString()}') to ('${to.toISOString()}')`;

    try {
      await this.#handle.client.unsafe(statement);
    } catch (error) {
      if (!isAlreadyCreated(error)) throw error;
    }
  }

  async listPartitions(): Promise<string[]> {
    const rows = await this.#handle.client<PartitionRow[]>`
      select c.relname as name
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
        join pg_namespace n on n.oid = p.relnamespace
       where p.relname = 'message_logs' and n.nspname = 'public'
       order by c.relname
    `;

    return rows.map((row) => row.name);
  }

  async dropPartitions(names: readonly string[]): Promise<void> {
    for (const name of names) {
      // The caller owns the list, so this is the last gate before a table name
      // reaches DROP TABLE. Refusing loudly beats dropping something else.
      if (!isPartitionName(name)) {
        throw new Error(
          `refusing to drop '${name}': not a message_logs partition name. ` +
            'Partition names are generated from a date and look like message_logs_2026_08_14.',
        );
      }

      await this.#handle.client.unsafe(`drop table if exists "${name}"`);
    }
  }

  async #exists(name: string): Promise<boolean> {
    const rows = await this.#handle.client<ExistsRow[]>`
      select to_regclass(${`public.${name}`}) is not null as present
    `;
    return rows[0]?.present === true;
  }

  async #insert(values: NewMessageLogRow[]): Promise<number> {
    // The conflict target is the whole primary key because Postgres requires the
    // partition key in it. `id` is derived from the dispatch, so a redelivered
    // event conflicts with itself and writes nothing (I4).
    const inserted = await this.#handle.db
      .insert(messageLogs)
      .values(values)
      .onConflictDoNothing({ target: [messageLogs.occurredAt, messageLogs.id] })
      .returning({ id: messageLogs.id });

    return inserted.length;
  }
}

function distinctDays(entries: readonly MessageLogEntry[]): Date[] {
  const days = new Map<number, Date>();
  for (const entry of entries) {
    const day = utcDayStart(entry.occurredAt);
    days.set(day.getTime(), day);
  }
  return [...days.values()];
}
