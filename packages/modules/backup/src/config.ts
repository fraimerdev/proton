import { protonFields } from '@proton/core';
import { z } from 'zod';

export const MAX_RETAINED_BACKUPS = 25;

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

export const BACKUP_SCHEMA_VERSION = 1;
