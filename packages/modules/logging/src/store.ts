/** What kind of change a log row records. */
export type MessageLogKind = 'edit' | 'delete' | 'bulk_delete';

export interface MessageLogEntry {
  /**
   * The originating event id.
   *
   * The gateway derives it deterministically from the dispatch, so a redelivered
   * MESSAGE_UPDATE produces the same id and the insert's ON CONFLICT turns the
   * second write into a no-op (I4). A bulk delete appends the message id, since
   * one event becomes one row per message.
   */
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  /** Null when Discord's payload does not name an author — every deletion. */
  authorId: string | null;
  kind: MessageLogKind;
  /** Null unless the previous text was known; see `events.ts` on why it rarely is. */
  contentBefore: string | null;
  contentAfter: string | null;
  /** Also the partition key: the row lands in the partition for this UTC day. */
  occurredAt: Date;
}

/**
 * Where message logs go.
 *
 * A port declared by the module rather than by `packages/core`, because §7 gives
 * a module its own tables but `ModuleContext` has no way to hand it a database.
 * Until that gap is closed the store is constructed by whoever wires the module
 * up (see `createLoggingModule`), which keeps the dependency explicit and the
 * handlers testable without Postgres.
 */
export interface MessageLogStore {
  /**
   * Append log rows, ignoring ones already recorded.
   *
   * Returns how many rows were actually written, so a caller can tell a genuine
   * write from a deduped redelivery.
   */
  append(entries: readonly MessageLogEntry[]): Promise<number>;

  /** Create the partition for a UTC day if it does not exist. Idempotent. */
  ensurePartition(day: Date): Promise<void>;

  /** Names of every partition currently attached to `message_logs`. */
  listPartitions(): Promise<string[]>;

  /** Drop partitions by name — O(1) per partition, whatever they contain. */
  dropPartitions(names: readonly string[]): Promise<void>;
}
