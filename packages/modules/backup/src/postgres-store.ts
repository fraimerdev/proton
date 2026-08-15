import { backups, type DbHandle } from '@proton/db';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { guildSnapshotSchema } from './snapshot.ts';
import { type BackupRecord, type BackupStore, CorruptSnapshotError } from './store.ts';

type Row = typeof backups.$inferSelect;

/**
 * Postgres implementation of §6's `backups` table.
 *
 * The snapshot is validated on **both** sides of the wire. On write because a
 * malformed document would only be discovered during a restore, which is the
 * worst possible moment; on read because the column is jsonb written by a
 * possibly older build, so what comes back is a claim about a snapshot rather
 * than one of ours. That is I5's rule — validate on every read and write —
 * applied to the module's own document instead of to its config.
 */
export interface DrizzleBackupStoreOptions {
  /**
   * Called for a stored row `list` could not read.
   *
   * A port rather than a `console` call so the host decides where it goes, and
   * so a test can assert that a dropped row was reported rather than swallowed.
   */
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
      // Drizzle serialises the jsonb column itself; a hand-rolled
      // `JSON.stringify` here would double-encode it into a jsonb *string*.
      snapshot,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    });
  }

  async get(guildId: string, backupId: string): Promise<BackupRecord | null> {
    const rows = await this.#handle.db
      .select()
      .from(backups)
      // Scoped by guild, not by id alone: a backup id is guessable enough that
      // an admin of one server must never be able to read another's layout by
      // pasting an id (I6's rule — a client-supplied id is never trusted alone).
      .where(and(eq(backups.guildId, guildId), eq(backups.id, backupId)))
      .limit(1);

    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Newest first, and one unreadable row does not hide the rest.
   *
   * `toRecord` throws `CorruptSnapshotError` on a snapshot that no longer parses,
   * which is right for `get` — restoring from a document you cannot read is the
   * one thing this module must refuse. It is wrong for a listing. `backups.snapshot`
   * is nullable and the table also carries `s3_key`, so a row whose payload lives
   * elsewhere is reachable rather than hypothetical, and mapping the array
   * eagerly meant a single such row made `/backup list` throw — hiding every good
   * snapshot the guild has, at the moment they are looking for one.
   *
   * So a bad row is dropped from the list and named in the log. It is still
   * unrestorable, and `get` still says so loudly when someone tries.
   */
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
      // Id breaks the tie: two snapshots taken in the same millisecond would
      // otherwise order arbitrarily, and `prune` could keep a different one than
      // `list` shows.
      .orderBy(desc(backups.createdAt), desc(backups.id))
      .limit(keep);

    const keepIds = survivors.map((row) => row.id);

    // `notInArray` with an empty list is not valid SQL, and the guild has no
    // snapshots anyway — there is nothing to delete.
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
