import type { GuildSnapshot } from './snapshot.ts';

export interface BackupRecord {
  id: string;
  guildId: string;

  version: number;

  createdBy: string | null;
  createdAt: Date;
  snapshot: GuildSnapshot;
}

export class CorruptSnapshotError extends Error {
  constructor(backupId: string, detail: string) {
    super(
      `Backup ${backupId} is stored in a shape Proton cannot read: ${detail}. It cannot be ` +
        'restored from. Take a fresh backup.',
    );
    this.name = 'CorruptSnapshotError';
  }
}

export interface BackupStore {
  save(record: BackupRecord): Promise<void>;
  get(guildId: string, backupId: string): Promise<BackupRecord | null>;

  list(guildId: string, limit: number): Promise<BackupRecord[]>;

  prune(guildId: string, keep: number): Promise<number>;
}
