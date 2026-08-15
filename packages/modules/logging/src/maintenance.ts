import { z } from 'zod';
import { MESSAGE_LOG_RETENTION_DAYS } from './config.ts';
import {
  partitionName,
  partitionsToDrop,
  partitionsToEnsure,
  retentionCutoff,
} from './partitions.ts';
import type { MessageLogStore } from './store.ts';

/** `(module_id, id)` keys the schedule, so this is unique within `logging`. */
export const PARTITION_MAINTENANCE_JOB_ID = 'partition-maintenance';

/**
 * Just after midnight UTC, which is when the day the job creates becomes the day
 * writes land in. Ten minutes past rather than on the hour so it does not share
 * an instant with every other daily job in the deployment.
 */
export const PARTITION_MAINTENANCE_CRON = '10 0 * * *';

/**
 * The job's payload, validated on read.
 *
 * It round-trips through a JSONB column, so "it came out of our own table" says
 * nothing about its shape — the same argument I5 makes about module config. The
 * bounds matter: a `retentionDays` of 0 would drop today's partition while the
 * listeners are still writing to it, which is the one bug in this module that
 * destroys data rather than failing to record it.
 */
export const maintenancePayloadSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).default(MESSAGE_LOG_RETENTION_DAYS),
  /** How many days ahead to pre-create. One is enough for a daily job. */
  lookaheadDays: z.number().int().min(1).max(7).default(1),
});

export type MaintenancePayload = z.infer<typeof maintenancePayloadSchema>;

export interface MaintenanceOptions extends Partial<MaintenancePayload> {
  now: Date;
}

export interface MaintenanceResult {
  /** Partitions that exist after the run — today plus the lookahead. */
  ensured: string[];
  dropped: string[];
  /** The oldest UTC day still kept, for logging what the sweep decided. */
  cutoff: Date;
}

/**
 * Roll the partition window forward: create tomorrow's, drop what is past
 * retention (PLAN.md §6, "TTL job").
 *
 * The drop is the whole point. Expiring a month of message content by `DELETE`
 * means rewriting every row and leaving the dead tuples for autovacuum, on the
 * largest table in the system; dropping a partition is a catalogue update whose
 * cost does not depend on what is inside it.
 *
 * Creation runs before deletion so that a run which fails half way has too many
 * partitions rather than too few — surplus costs disk, absence loses writes.
 */
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
