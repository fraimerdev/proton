import type { DbHandle } from '@proton/db';
import { isPartitionName, partitionName, partitionRange, utcDayStart } from './partitions.ts';
import type { MessageLogEntry, MessageLogStore } from './store.ts';
import { messageLogs, type NewMessageLogRow } from './table.ts';

type PartitionRow = { name: string };
type ExistsRow = { present: boolean };

const CHECK_VIOLATION = '23514';
const DUPLICATE_TABLE = '42P07';
const UNIQUE_VIOLATION = '23505';

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

function isMissingPartition(error: unknown): boolean {
  return errorCode(error) === CHECK_VIOLATION;
}

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

export class PostgresMessageLogStore implements MessageLogStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

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

    if (await this.#exists(name)) return;

    const { from, to } = partitionRange(day);

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
