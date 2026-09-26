import { describe, expect, test } from 'bun:test';
import { moduleScheduleKey } from '@proton/core';
import {
  AUTOSYNC_OVERDUE_MS,
  JOINROLES_AUTOSYNC_JOB,
  JOINROLES_AUTOSYNC_KEY,
  SYNC_INTERVAL_MS,
} from '../src/sync/autosync.ts';
import { createJoinRolesSyncListener } from '../src/sync/listener.ts';
import { JOINROLES_SYNC_JOB, syncBatchKey } from '../src/sync/run.ts';
import { GUILD, ROLE_LOW } from './harness.ts';
import { ACTOR, NOW, serviceEvent, syncHarness } from './sync-harness.ts';

const AUTOSYNC_ROW = moduleScheduleKey(
  'joinroles',
  JOINROLES_AUTOSYNC_JOB,
  GUILD,
  'joinroles:autosync',
);

function batchRow(runId: string): string {
  return moduleScheduleKey('joinroles', JOINROLES_SYNC_JOB, GUILD, syncBatchKey(runId));
}

function requested(runId: string, overrides: Record<string, unknown> = {}) {
  return serviceEvent('joinroles.sync_requested', {
    auditId: 'audit-1',
    guildId: GUILD,
    runId,
    kind: 'sync',
    actorId: ACTOR,
    ...overrides,
  });
}

function configChanged(overrides: Record<string, unknown> = {}) {
  return serviceEvent('proton.config_changed', {
    auditId: 'audit-2',
    guildId: GUILD,
    moduleId: 'joinroles',
    actorId: ACTOR,
    source: 'dashboard',
    enabledBefore: true,
    enabledAfter: true,
    changedKeys: [],
    ...overrides,
  });
}

describe('a sync request', () => {
  test('books the first batch for the queued run it names', async () => {
    const h = syncHarness();
    h.queue();

    await createJoinRolesSyncListener(h.deps).handler(requested('run-1'), h.ctx());

    expect(h.scheduler.calls).toEqual([
      {
        jobId: JOINROLES_SYNC_JOB,
        runAt: NOW,
        naturalKey: 'joinroles:sync:run-1',
        data: { runId: 'run-1' },
        replace: false,
      },
    ]);
  });

  test('a batch row left by an earlier run does not stand in the way of a new one', async () => {
    const h = syncHarness();
    await h.scheduler.schedule(
      JOINROLES_SYNC_JOB,
      new Date(NOW - 86_400_000),
      syncBatchKey('run-0'),
      { runId: 'run-0' },
    );
    h.queue();

    await createJoinRolesSyncListener(h.deps).handler(requested('run-1'), h.ctx());

    expect(h.scheduler.table.get(batchRow('run-1'))).toMatchObject({ runAt: NOW });
  });

  test('a redelivered request books nothing new', async () => {
    const h = syncHarness();
    h.queue();
    const listener = createJoinRolesSyncListener(h.deps);

    await listener.handler(requested('run-1'), h.ctx());
    h.clock.now = NOW + 5_000;
    await listener.handler(requested('run-1'), h.ctx());

    expect(h.scheduler.table.size).toBe(1);
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)?.runAt).toBe(NOW);
    expect(h.scheduler.calls.every((call) => !call.replace)).toBe(true);
  });

  test('ignores a request for another run, or for a run that already started', async () => {
    const h = syncHarness();
    const listener = createJoinRolesSyncListener(h.deps);

    h.queue();
    await listener.handler(requested('run-0'), h.ctx());

    h.runs.seed({ ...h.queue(), state: 'running' });
    await listener.handler(requested('run-1'), h.ctx());

    await listener.handler(requested('run-1', { guildId: '900000000000000002' }), h.ctx());

    expect(h.scheduler.calls).toEqual([]);
  });

  test('ignores a request when no run is stored at all', async () => {
    const h = syncHarness();

    await createJoinRolesSyncListener(h.deps).handler(requested('run-1'), h.ctx());

    expect(h.scheduler.calls).toEqual([]);
  });
});

describe('Join Roles config changes', () => {
  test('switching the module off stops the sync and cancels both jobs', async () => {
    const h = syncHarness();
    h.runs.seed({ ...h.queue(), state: 'running', processed: 1200, startedAt: NOW - 60_000 });

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ enabledAfter: false, changedKeys: ['enabled'] }),
      h.ctx({ enabled: false }),
    );

    expect(await h.runs.get(GUILD)).toBeNull();
    expect(await h.runs.last(GUILD)).toMatchObject({
      outcome: 'stopped',
      processed: 1200,
      failure: { code: 'switched_off', message: 'Join Roles was turned off.' },
    });
    expect(h.scheduler.cancelled).toEqual([batchRow('run-1'), AUTOSYNC_ROW]);
  });

  test('a switch-off delivered again after the module came back on leaves the new run alone', async () => {
    const h = syncHarness();
    const listener = createJoinRolesSyncListener(h.deps);
    const on = h.ctx({ syncScheduleEnabled: true });

    await listener.handler(configChanged({ changedKeys: ['enabled'] }), on);
    h.clock.now = NOW + 60_000;
    h.queue({ runId: 'newer' });

    await listener.handler(
      { ...configChanged({ enabledAfter: false, changedKeys: ['enabled'] }), id: 'old' },
      on,
    );

    expect((await h.runs.get(GUILD))?.runId).toBe('newer');
    expect(await h.runs.last(GUILD)).toBeNull();
    expect(h.scheduler.cancelled).toEqual([]);
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.weekly);
  });

  test('switching off with no run stored still cancels the scheduled sync', async () => {
    const h = syncHarness();

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ enabledAfter: false }),
      h.ctx({ enabled: false }),
    );

    expect(h.scheduler.cancelled).toEqual([AUTOSYNC_ROW]);
  });

  test('switching off during a count clears it without writing a last sync', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ enabledAfter: false }),
      h.ctx({ enabled: false }),
    );

    expect(await h.runs.get(GUILD)).toBeNull();
    expect(await h.runs.last(GUILD)).toBeNull();
  });

  test('switching the schedule on books it an interval out, replacing any booking', async () => {
    const h = syncHarness();

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ changedKeys: ['syncScheduleEnabled'] }),
      h.ctx({ syncScheduleEnabled: true, syncInterval: 'daily' }),
    );

    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)).toEqual({
      jobId: JOINROLES_AUTOSYNC_JOB,
      runAt: NOW + SYNC_INTERVAL_MS.daily,
      naturalKey: 'joinroles:autosync',
      data: { slot: NOW + SYNC_INTERVAL_MS.daily },
      replace: true,
    });
    expect(await h.runs.autosyncAt(GUILD)).toBe(NOW + SYNC_INTERVAL_MS.daily);
  });

  test('changing the interval moves the booking', async () => {
    const h = syncHarness();
    const listener = createJoinRolesSyncListener(h.deps);

    await listener.handler(
      configChanged({ changedKeys: ['syncScheduleEnabled'] }),
      h.ctx({ syncScheduleEnabled: true, syncInterval: 'weekly' }),
    );
    await listener.handler(
      configChanged({ changedKeys: ['syncInterval'] }),
      h.ctx({ syncScheduleEnabled: true, syncInterval: 'daily' }),
    );

    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.daily);
  });

  test('any other change keeps the existing booking', async () => {
    const h = syncHarness();
    const listener = createJoinRolesSyncListener(h.deps);

    await listener.handler(
      configChanged({ changedKeys: ['syncScheduleEnabled'] }),
      h.ctx({ syncScheduleEnabled: true }),
    );
    h.clock.now = NOW + 60_000;
    await listener.handler(
      configChanged({ changedKeys: ['memberRoleIds'] }),
      h.ctx({ syncScheduleEnabled: true, memberRoleIds: [ROLE_LOW] }),
    );

    expect(h.scheduler.calls.at(-1)?.replace).toBe(false);
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.weekly);
  });

  test('switching the schedule off cancels it', async () => {
    const h = syncHarness();

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ changedKeys: ['syncScheduleEnabled'] }),
      h.ctx({ syncScheduleEnabled: false }),
    );

    expect(h.scheduler.cancelled).toEqual([AUTOSYNC_ROW]);
    expect(h.scheduler.calls).toEqual([]);
  });

  test('another change rebooks a scheduled sync whose booking was given up on', async () => {
    const h = syncHarness();
    const due = NOW - AUTOSYNC_OVERDUE_MS;
    await h.scheduler.schedule(JOINROLES_AUTOSYNC_JOB, new Date(due), JOINROLES_AUTOSYNC_KEY, {
      slot: due,
    });
    await h.runs.setAutosyncAt(GUILD, due);

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ changedKeys: ['memberRoleIds'] }),
      h.ctx({ syncScheduleEnabled: true }),
    );

    const at = NOW + SYNC_INTERVAL_MS.weekly;
    expect(h.scheduler.calls.map((call) => call.replace)).toEqual([false, false, true]);
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)).toMatchObject({
      runAt: at,
      data: { slot: at },
    });
    expect(await h.runs.autosyncAt(GUILD)).toBe(at);
    expect(h.lines.join('\n')).toContain('never ran');
  });

  test('another module’s change is ignored', async () => {
    const h = syncHarness();
    h.queue();

    await createJoinRolesSyncListener(h.deps).handler(
      configChanged({ moduleId: 'counters', enabledAfter: false }),
      h.ctx({ syncScheduleEnabled: true }),
    );

    expect(await h.runs.get(GUILD)).not.toBeNull();
    expect(h.scheduler.calls).toEqual([]);
    expect(h.scheduler.cancelled).toEqual([]);
  });
});

describe('guild.available', () => {
  test('keeps an existing scheduled sync where it is', async () => {
    const h = syncHarness();
    const listener = createJoinRolesSyncListener(h.deps);

    await listener.handler(
      serviceEvent('guild.available', {}),
      h.ctx({ syncScheduleEnabled: true }),
    );
    h.clock.now = NOW + 3_600_000;
    await listener.handler(
      serviceEvent('guild.available', {}),
      h.ctx({ syncScheduleEnabled: true }),
    );

    expect(h.scheduler.calls.map((call) => call.replace)).toEqual([false, false]);
    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.weekly);
  });

  test('keeps a booking that came due moments ago, since a sweep is about to run it', async () => {
    const h = syncHarness();
    const due = NOW - 60_000;
    await h.scheduler.schedule(JOINROLES_AUTOSYNC_JOB, new Date(due), JOINROLES_AUTOSYNC_KEY, {
      slot: due,
    });
    await h.runs.setAutosyncAt(GUILD, due);

    await createJoinRolesSyncListener(h.deps).handler(
      serviceEvent('guild.available', {}),
      h.ctx({ syncScheduleEnabled: true }),
    );

    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(due);
    expect(await h.runs.autosyncAt(GUILD)).toBe(due);
  });

  test('rebooks a booking Proton has no due time for, rather than trust it', async () => {
    const h = syncHarness();
    await h.scheduler.schedule(JOINROLES_AUTOSYNC_JOB, new Date(NOW), JOINROLES_AUTOSYNC_KEY, {
      slot: NOW,
    });

    await createJoinRolesSyncListener(h.deps).handler(
      serviceEvent('guild.available', {}),
      h.ctx({ syncScheduleEnabled: true, syncInterval: 'daily' }),
    );

    expect(h.scheduler.booked(JOINROLES_AUTOSYNC_JOB)?.runAt).toBe(NOW + SYNC_INTERVAL_MS.daily);
    expect(await h.runs.autosyncAt(GUILD)).toBe(NOW + SYNC_INTERVAL_MS.daily);
  });

  test('books nothing while the schedule is off', async () => {
    const h = syncHarness();

    await createJoinRolesSyncListener(h.deps).handler(serviceEvent('guild.available', {}), h.ctx());

    expect(h.scheduler.calls).toEqual([]);
  });
});
