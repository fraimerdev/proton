import { backups, type DbHandle } from '@proton/db';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { guildSnapshotSchema } from './snapshot.ts';
import { type BackupRecord, type BackupStore, CorruptSnapshotError } from './store.ts';

type Row = typeof backups.$inferSelect;

export interface DrizzleBackupStoreOptions {
  onUnreadable?(backupId: string, detail: string): void;
}

export class DrizzleBackupStore implements BackupStore {
  readonly #handle: DbHandle;
  readonly #onUnreadable: DrizzleBackupStoreOptions['onUnreadable'];

  constructor(handle: DbHandle, options: DrizzleBackupStoreOptions = {}) {
    this.#handle = handle;
    this.#onUnreadable = options.onUnreadable;
  }

  async save(record: BackupRecord): Promise<void> {
    const snapshot = guildSnapshotSchema.parse(record.snapshot);

    await this.#handle.db.insert(backups).values({
      id: record.id,
      guildId: record.guildId,
      version: record.version,

      snapshot,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    });
  }

  async get(guildId: string, backupId: string): Promise<BackupRecord | null> {
    const rows = await this.#handle.db
      .select()
      .from(backups)

      .where(and(eq(backups.guildId, guildId), eq(backups.id, backupId)))
      .limit(1);

    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async list(guildId: string, limit: number): Promise<BackupRecord[]> {
    const rows = await this.#handle.db
      .select()
      .from(backups)
      .where(eq(backups.guildId, guildId))
      .orderBy(desc(backups.createdAt), desc(backups.id))
      .limit(limit);

    const records: BackupRecord[] = [];
    for (const row of rows) {
      try {
        records.push(toRecord(row));
      } catch (error) {
        this.#onUnreadable?.(row.id, error instanceof Error ? error.message : String(error));
      }
    }

    return records;
  }

  async prune(guildId: string, keep: number): Promise<number> {
    const survivors = await this.#handle.db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.guildId, guildId))

      .orderBy(desc(backups.createdAt), desc(backups.id))
      .limit(keep);

    const keepIds = survivors.map((row) => row.id);

    if (keepIds.length === 0) return 0;

    const deleted = await this.#handle.db
      .delete(backups)
      .where(and(eq(backups.guildId, guildId), notInArray(backups.id, keepIds)))
      .returning({ id: backups.id });

    return deleted.length;
  }
}

function toRecord(row: Row): BackupRecord {
  const parsed = guildSnapshotSchema.safeParse(row.snapshot);

  if (!parsed.success) {
    throw new CorruptSnapshotError(
      row.id,
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'} ${issue.message}`)
        .join('; '),
    );
  }

  return {
    id: row.id,
    guildId: row.guildId,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    snapshot: parsed.data,
  };
}
