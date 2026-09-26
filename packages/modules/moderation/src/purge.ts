import type { CaseMessageStore } from './punish/store.ts';
import type { ReportStore } from './reports/store.ts';

export const PURGE_EVIDENCE_JOB_ID = 'purge-evidence';
export const PURGE_EVIDENCE_CRON = '35 * * * *';
export const PURGE_EVIDENCE_BATCH = 500;
export const PURGE_EVIDENCE_ROUNDS = 40;

export interface EvidenceStores {
  reports?: Pick<ReportStore, 'purgeExpiredEvidence'> | undefined;
  caseMessages?: Pick<CaseMessageStore, 'purgeExpired'> | undefined;
}

export interface EvidencePurge {
  reports: number;
  caseMessages: number;
}

export interface PurgeOptions {
  batch?: number;
  rounds?: number;
}

async function purgeReports(
  store: Pick<ReportStore, 'purgeExpiredEvidence'>,
  now: number,
  batch: number,
  rounds: number,
): Promise<number> {
  let purged = 0;

  for (let round = 0; round < rounds; round += 1) {
    const count = await store.purgeExpiredEvidence(now, batch);
    purged += count;
    if (count < batch) break;
  }

  return purged;
}

export async function purgeModerationEvidence(
  stores: EvidenceStores,
  now: Date,
  options: PurgeOptions = {},
): Promise<EvidencePurge> {
  const batch = options.batch ?? PURGE_EVIDENCE_BATCH;
  const rounds = options.rounds ?? PURGE_EVIDENCE_ROUNDS;

  const [reports, caseMessages] = await Promise.allSettled([
    stores.reports ? purgeReports(stores.reports, now.getTime(), batch, rounds) : 0,
    stores.caseMessages ? stores.caseMessages.purgeExpired(now) : 0,
  ]);

  if (reports.status === 'rejected') throw reports.reason;
  if (caseMessages.status === 'rejected') throw caseMessages.reason;

  return { reports: reports.value, caseMessages: caseMessages.value };
}
