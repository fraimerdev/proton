import type { GuildSnapshot } from './snapshot.ts';

export interface BackupRecord {
  id: string;
  guildId: string;
  /** Snapshot format version — `backups.version` (§6). */
  version: number;
  /** Who ran `/backup create`; null for a snapshot Proton took by itself. */
  createdBy: string | null;
  createdAt: Date;
  snapshot: GuildSnapshot;
}

/**
 * A stored snapshot that does not parse against `guildSnapshotSchema`.
 *
 * Thrown rather than swallowed. A snapshot read back as an empty object would
 * plan a restore that skips everything and reports "0 channels to recreate",
 * which reads exactly like a healthy server — the failure would be invisible at
 * the one moment it matters most.
 */
export class CorruptSnapshotError extends Error {
  constructor(backupId: string, detail: string) {
    super(
      `Backup ${backupId} is stored in a shape Proton cannot read: ${detail}. It cannot be ` +
        'restored from. Take a fresh backup.',
    );
    this.name = 'CorruptSnapshotError';
  }
}

/**
 * Where snapshots live.
 *
 * A port declared by the module, for the same reason `MessageLogStore` is one:
 * §7 gives a module its own tables but `ModuleContext` has no way to hand it a
 * database. `backups` itself is a core table (§6), so this module ships no
 * migration — it borrows the row and owns the document inside it.
 */
export interface BackupStore {
  /** Validates the snapshot on the way in (I5, applied to the document). */
  save(record: BackupRecord): Promise<void>;
  get(guildId: string, backupId: string): Promise<BackupRecord | null>;
  /** Newest first. */
  list(guildId: string, limit: number): Promise<BackupRecord[]>;
  /**
   * Delete all but the newest `keep` snapshots for a guild. Returns how many
   * were deleted, so the caller can say so rather than guess.
   */
  prune(guildId: string, keep: number): Promise<number>;
}
