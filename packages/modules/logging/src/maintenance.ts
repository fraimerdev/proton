import { z } from 'zod';
import { MESSAGE_LOG_RETENTION_DAYS } from './constants.ts';
import {
  partitionName,
  partitionsToDrop,
  partitionsToEnsure,
  retentionCutoff,
} from './partitions.ts';
import type { MessageLogStore } from './store.ts';

export const PARTITION_MAINTENANCE_JOB_ID = 'partition-maintenance';

export const PARTITION_MAINTENANCE_CRON = '10 0 * * *';

export const maintenancePayloadSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).default(MESSAGE_LOG_RETENTION_DAYS),

  lookaheadDays: z.number().int().min(1).max(7).default(1),
});

export type MaintenancePayload = z.infer<typeof maintenancePayloadSchema>;

export interface MaintenanceOptions extends Partial<MaintenancePayload> {
  now: Date;
}

export interface MaintenanceResult {
  ensured: string[];
  dropped: string[];

  cutoff: Date;
}

export async function runMessageLogMaintenance(
  store: MessageLogStore,
  options: MaintenanceOptions,
): Promise<MaintenanceResult> {
  const { retentionDays, lookaheadDays } = maintenancePayloadSchema.parse({
    ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
    ...(options.lookaheadDays !== undefined ? { lookaheadDays: options.lookaheadDays } : {}),
  });

  const ensured: string[] = [];
  for (const day of partitionsToEnsure(options.now, lookaheadDays)) {
    await store.ensurePartition(day);
    ensured.push(partitionName(day));
  }

  const cutoff = retentionCutoff(options.now, retentionDays);
  const dropped = partitionsToDrop(await store.listPartitions(), cutoff);
  await store.dropPartitions(dropped);

  return { ensured, dropped, cutoff };
}
