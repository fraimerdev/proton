import { describe, expect, test } from 'bun:test';
import { claimRun } from '../src/sync/store.ts';
import { isStaleRun, queuedRun, SYNC_STALE_MS, type SyncRun } from '../src/sync/view.ts';
import { GUILD } from './harness.ts';
import { ACTOR, MemoryRunStore, NOW } from './sync-harness.ts';

function run(runId: string, overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    ...queuedRun({
      runId,
      guildId: GUILD,
      kind: 'sync',
      trigger: 'dashboard',
      actorId: ACTOR,
      now: NOW,
    }),
    ...overrides,
  };
}

describe('claiming the run slot', () => {
  test('an empty slot is claimed', async () => {
    const runs = new MemoryRunStore();

    expect(await claimRun(runs, run('new'), NOW)).toEqual({ claimed: true, replaced: null });
    expect((await runs.get(GUILD))?.runId).toBe('new');
  });

  test('a run that reported progress inside the window keeps the slot', async () => {
    for (const state of ['queued', 'running'] as const) {
      const runs = new MemoryRunStore();
      const held = run('old', { state, heartbeatAt: NOW - SYNC_STALE_MS + 1 });
      runs.seed(held);

      expect(await claimRun(runs, run('new'), NOW)).toEqual({ claimed: false, current: held });
      expect(await runs.get(GUILD)).toEqual(held);
    }
  });

  test('a queued or running run silent for the whole window is replaced', async () => {
    for (const state of ['queued', 'running'] as const) {
      const runs = new MemoryRunStore();
      const held = run('old', { state, heartbeatAt: NOW - SYNC_STALE_MS });
      runs.seed(held);

      expect(await claimRun(runs, run('new'), NOW)).toEqual({ claimed: true, replaced: held });
      expect((await runs.get(GUILD))?.runId).toBe('new');
    }
  });

  test('the same run is never replaced by itself, however old', async () => {
    const runs = new MemoryRunStore();
    const held = run('same', { heartbeatAt: NOW - 10 * SYNC_STALE_MS });
    runs.seed(held);

    expect(await claimRun(runs, run('same'), NOW)).toEqual({ claimed: false, current: held });
  });

  test('staleness is judged on the last progress, not on when the run was queued', () => {
    const old = run('old', { queuedAt: NOW - 10 * SYNC_STALE_MS, heartbeatAt: NOW - 1_000 });

    expect(isStaleRun(old, NOW)).toBe(false);
    expect(isStaleRun(old, NOW + SYNC_STALE_MS)).toBe(true);
  });
});
