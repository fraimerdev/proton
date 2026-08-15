export type MessageLogKind = 'edit' | 'delete' | 'bulk_delete';

export interface MessageLogEntry {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;

  authorId: string | null;
  kind: MessageLogKind;

  contentBefore: string | null;
  contentAfter: string | null;

  occurredAt: Date;
}

export interface MessageLogStore {
  append(entries: readonly MessageLogEntry[]): Promise<number>;

  ensurePartition(day: Date): Promise<void>;

  listPartitions(): Promise<string[]>;

  dropPartitions(names: readonly string[]): Promise<void>;
}
