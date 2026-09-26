import { describe, expect, test } from 'bun:test';
import type { ModerationDeps } from '../src/deps.ts';
import { createPatrolHandler, PATROL_INTERVAL_MS, PATROL_JOB } from '../src/reports/patrol.ts';
import type { ReportStore } from '../src/reports/store.ts';
import { harness } from './harness.ts';
import { REPORT_CHANNEL } from './reports-setup.ts';

const REPORTS_ON = { reports: { enabled: true, channelId: REPORT_CHANNEL } };

function failingStore(): ReportStore {
  return new Proxy({} as ReportStore, {
    get: () => async () => {
      throw new Error('the database is down');
    },
  });
}

describe('the reports patrol job', () => {
  test('the manifest runs it and books the next round', async () => {
    const h = harness();

    expect(await h.job(PATROL_JOB, {}, { configInput: REPORTS_ON, naturalKey: 'patrol' })).toBe(
      true,
    );

    const next = h.pendingJobs().find((job) => job.jobId === PATROL_JOB);
    expect(next?.runAt.getTime()).toBe(h.now() + PATROL_INTERVAL_MS);
  });

  test('books the next round even when this one fails', async () => {
    const h = harness();
    const deps: ModerationDeps = { reports: failingStore(), now: h.now };
    const ctx = h.context({ configInput: REPORTS_ON });

    await expect(createPatrolHandler(deps)({}, ctx)).rejects.toThrow('the database is down');

    expect(h.pendingJobs().map((job) => job.jobId)).toEqual([PATROL_JOB]);
  });

  test('does nothing while Moderation is off', async () => {
    const h = harness();
    const deps: ModerationDeps = { reports: failingStore(), now: h.now };
    const ctx = h.context({ configInput: { ...REPORTS_ON, enabled: false } });

    await createPatrolHandler(deps)({}, ctx);

    expect(h.pendingJobs()).toEqual([]);
    expect(h.rest.calls).toEqual([]);
  });
});
