import { protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * How many snapshots one guild may keep.
 *
 * A snapshot is a jsonb document holding every channel, role and overwrite in
 * the server, so an uncapped history is unbounded growth in the one column
 * nobody ever looks at. The cap is a hard schema limit rather than advice.
 */
export const MAX_RETAINED_BACKUPS = 25;

/**
 * Backup's configuration.
 *
 * Two settings, because there are only two things a server owner genuinely
 * disagrees about. Everything else this module does is either forced by Discord
 * (§10.1) or is a correctness rule that must not be switchable: it always
 * reports the channels it could not capture, and it always refuses to recreate
 * one it could not read. A "don't warn me about hidden channels" toggle would
 * turn a trustworthy backup into a silently partial one, which §10.1 names as
 * the specific way naive backup/restore breaks.
 */
export const backupConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Answer /backup in this server.',
  }),

  retainBackups: z
    .number()
    .int()
    .min(1)
    .max(MAX_RETAINED_BACKUPS)
    .default(10)
    .register(protonFields, {
      label: 'Snapshots to keep',
      description:
        'How many snapshots to keep for this server. Taking a new one deletes the oldest ' +
        'beyond this count. Each snapshot holds every channel, role and permission overwrite ' +
        'at the moment it was taken.',
    }),
});

export type BackupConfig = z.infer<typeof backupConfigSchema>;

export const backupDefaultConfig: BackupConfig = {
  enabled: true,
  retainBackups: 10,
};

/** Bumped whenever the shape above changes (I5). */
export const BACKUP_SCHEMA_VERSION = 1;
