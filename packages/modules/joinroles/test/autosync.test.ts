import { describe, expect, test } from 'bun:test';
import {
  AUTOSYNC_BUSY_RETRY_MS,
  createAutosyncHandler,
  JOINROLES_AUTOSYNC_JOB,
  SYNC_INTERVAL_MS,
} from '../src/sync/autosync.ts';
import { finishRun, JOINROLES_SYNC_JOB } from '../src/sync/run.ts';
import { SYNC_STALE_MS } from '../src/sync/view.ts';
import { GUILD, ROLE_LOW } from './harness.ts';
import { NOW, syncHarness } from './sync-harness.ts';

const SLOT = NOW - 1_000;

describe('the scheduled sync', () => {
  test('starts a run with the schedule trigger and books the next one an interval out', async () => {
    const h = syncHarness();

    await createAutosyncHandler(h.deps)(
      { slot: SLOT },
      h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true, syncInterval: 'daily' }),
    );

    expect(await h.runs.get(GUILD)).toMatchObject({
      runId: `s${SLOT}`,
      kind: 'sync',
      trigger: 'schedule',
      actorId: null,
      state: 'queued',
    });
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toMatchObject({ runAt: NOW, replace: false });
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)).toMatchObject({
      runAt: NOW + SYNC_INTERVAL_MS.daily,
      data: { slot: NOW + SYNC_INTERVAL_MS.daily },
    });
  });

  test('weekly books a week out', async () => {
    const h = syncHarness();

    await createAutosyncHandler(h.deps)(
      { slot: SLOT },
      h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true }),
    );

    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.weekly);
  });

  test('waits an hour instead of overlapping a sync that is already running', async () => {
    const h = syncHarness();
    h.queue({ runId: 'dashboard-run' });

    await createAutosyncHandler(h.deps)(
      { slot: SLOT },
      h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true }),
    );

    expect((await h.runs.get(GUILD))?.runId).toBe('dashboard-run');
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toBeUndefined();
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + AUTOSYNC_BUSY_RETRY_MS);
  });

  test('the same slot delivered twice starts one run', async () => {
    const h = syncHarness();
    const handler = createAutosyncHandler(h.deps);
    const ctx = h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true });

    await handler({ slot: SLOT }, ctx);
    const first = await h.runs.get(GUILD);
    await handler({ slot: SLOT }, ctx);

    expect(await h.runs.get(GUILD)).toEqual(first);
    expect(h.scheduler.calls.filter((call) => call.jobId === JOINROLES_SYNC_JOB)).toHaveLength(2);
    expect(
      [...h.scheduler.table.values()].filter((b) => b.jobId === JOINROLES_SYNC_JOB),
    ).toHaveLength(1);
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.weekly);
  });

  test('a slot whose sync already finished is not run again', async () => {
    const h = syncHarness();
    const handler = createAutosyncHandler(h.deps);
    const ctx = h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true });

    await handler({ slot: SLOT }, ctx);
    const run = await h.runs.get(GUILD);
    if (!run) throw new Error('the scheduled sync did not start');
    await finishRun(ctx, h.runs, run, 'done', null, NOW);
    h.clock.now = NOW + 60_000;

    await handler({ slot: SLOT }, ctx);

    expect(await h.runs.get(GUILD)).toBeNull();
    expect((await h.runs.last(GUILD))?.finishedAt).toBe(NOW);
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(
      NOW + 60_000 + SYNC_INTERVAL_MS.weekly,
    );
  });

  test('takes over a run that stopped reporting progress instead of waiting behind it', async () => {
    const h = syncHarness();
    h.runs.seed({
      ...h.queue({ runId: 'dashboard-run', now: NOW - 3 * 60 * 60_000 }),
      state: 'running',
      heartbeatAt: NOW - SYNC_STALE_MS,
    });

    await createAutosyncHandler(h.deps)(
      { slot: SLOT },
      h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true }),
    );

    expect(await h.runs.get(GUILD)).toMatchObject({ runId: `s${SLOT}`, state: 'queued' });
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toMatchObject({
      naturalKey: `joinroles:sync:s${SLOT}`,
      data: { runId: `s${SLOT}` },
    });
    expect(h.lines.join('\n')).toContain('reported no progress');
  });

  test('records when the next scheduled sync is due', async () => {
    const h = syncHarness();

    await createAutosyncHandler(h.deps)(
      { slot: SLOT },
      h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: true, syncInterval: 'daily' }),
    );

    expect(await h.runs.autosyncAt(GUILD)).toBe(NOW + SYNC_INTERVAL_MS.daily);
  });

  test('stops the chain once the schedule is switched off', async () => {
    const h = syncHarness();

    await createAutosyncHandler(h.deps)(
      { slot: SLOT },
      h.ctx({ memberRoleIds: [ROLE_LOW], syncScheduleEnabled: false }),
    );

    expect(await h.runs.get(GUILD)).toBeNull();
    expect(h.scheduler.calls).toEqual([]);
  });

  test('with no roles set, it books the next one without starting a run', async () => {
    const h = syncHarness();

    await createAutosyncHandler(h.deps)({ slot: SLOT }, h.ctx({ syncScheduleEnabled: true }));

    expect(await h.runs.get(GUILD)).toBeNull();
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)).toBeDefined();
  });
});
