import { describe, expect, test } from 'bun:test';
import { type ModuleContext, ModuleRegistry, type ProtonEvent } from '@proton/core';
import { ACTIVITY_RETENTION_DAYS, type ActivityStore } from '../src/activity.ts';
import { type LevelingConfig, XP_EVENT_RETENTION_MS } from '../src/config.ts';
import { createLevelingModule } from '../src/index.ts';
import {
  createPruneHandler,
  createPruneListener,
  PRUNE_INTERVAL_MS,
  PRUNE_JOB_ID,
  PRUNE_KEY,
} from '../src/prune.ts';
import { FakeXpEventStore, GUILD, listenerContext, xpEvent } from './fakes.ts';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

interface Booking {
  jobId: string;
  runAt: number;
  naturalKey: string;
  replace: boolean;
}

function scheduling(config: Partial<LevelingConfig> = { enabled: true }) {
  const recorded = listenerContext(config);
  const booked: Booking[] = [];
  const cancelled: { jobId: string; naturalKey: string }[] = [];

  const ctx: ModuleContext<LevelingConfig> = {
    ...recorded.ctx,
    schedule: async (jobId, runAt, naturalKey, _data, options) => {
      booked.push({
        jobId,
        runAt: runAt.getTime(),
        naturalKey,
        replace: options?.replace === true,
      });
      return { scheduled: true, replaced: false };
    },
    cancel: async (jobId, naturalKey) => {
      cancelled.push({ jobId, naturalKey });
    },
  };

  return { ctx, booked, cancelled, logs: recorded.logs };
}

function event(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return { id: `${type}:${GUILD}`, type, guildId: GUILD, occurredAt: NOW, payload };
}

function recordingActivity(): {
  store: ActivityStore;
  prunes: { guildId: string; before: number }[];
} {
  const prunes: { guildId: string; before: number }[] = [];

  return {
    prunes,
    store: {
      totals: async () => new Map(),
      stats: async () => new Map(),
      topRanked: async () => [],
      prune: async (guildId, before) => {
        prunes.push({ guildId, before: before.getTime() });
        return 3;
      },
    },
  };
}

const nextRun: Booking = {
  jobId: PRUNE_JOB_ID,
  runAt: NOW + PRUNE_INTERVAL_MS,
  naturalKey: PRUNE_KEY,
  replace: false,
};

describe('arming the activity prune', () => {
  test('a guild becoming available books the next prune a day out, kept rather than replaced', async () => {
    const { ctx, booked } = scheduling();

    await createPruneListener({ now: () => NOW }).handler(
      event('guild.available', { id: GUILD }),
      ctx,
    );

    expect(booked).toEqual([nextRun]);
  });

  test('a Leveling settings change re-arms it, restarting a prune dropped while switched off', async () => {
    const { ctx, booked } = scheduling();

    await createPruneListener({ now: () => NOW }).handler(
      event('proton.config_changed', { moduleId: 'leveling' }),
      ctx,
    );

    expect(booked).toEqual([nextRun]);
  });

  test("another module's settings change leaves the prune alone", async () => {
    const { ctx, booked, cancelled } = scheduling();

    await createPruneListener({ now: () => NOW }).handler(
      event('proton.config_changed', { moduleId: 'tickets' }),
      ctx,
    );

    expect(booked).toHaveLength(0);
    expect(cancelled).toHaveLength(0);
  });

  test('Leveling switched off in its own settings cancels the prune instead of booking one', async () => {
    const { ctx, booked, cancelled } = scheduling({ enabled: false });

    await createPruneListener({ now: () => NOW }).handler(
      event('guild.available', { id: GUILD }),
      ctx,
    );

    expect(booked).toHaveLength(0);
    expect(cancelled).toEqual([{ jobId: PRUNE_JOB_ID, naturalKey: PRUNE_KEY }]);
  });
});

describe('running the activity prune', () => {
  test("prunes only this guild's rows past retention, then books the next run", async () => {
    const activity = recordingActivity();
    const { ctx, booked } = scheduling();

    await createPruneHandler(activity.store, () => NOW)({}, ctx);

    expect(activity.prunes).toEqual([
      { guildId: GUILD, before: NOW - ACTIVITY_RETENTION_DAYS * DAY_MS },
    ]);
    expect(booked).toEqual([nextRun]);
  });

  test('clears out XP events that ended more than a week ago, with no new event created', async () => {
    const activity = recordingActivity();
    const xpEvents = new FakeXpEventStore().seed(
      xpEvent({ id: 'old', startsAt: NOW - 9 * DAY_MS, endsAt: NOW - 8 * DAY_MS }),
      xpEvent({ id: 'recent', startsAt: NOW - 2 * DAY_MS, endsAt: NOW - DAY_MS }),
    );
    const { ctx, booked } = scheduling();

    await createPruneHandler(activity.store, () => NOW, xpEvents)({}, ctx);

    expect(xpEvents.purges).toEqual([{ guildId: GUILD, before: NOW - XP_EVENT_RETENTION_MS }]);
    expect(xpEvents.of(GUILD).map((held) => held.id)).toEqual(['recent']);
    expect(xpEvents.calls).not.toContain('create');
    expect(booked).toEqual([nextRun]);
  });

  test('an XP event purge that fails is logged, and the activity prune and next run still happen', async () => {
    const activity = recordingActivity();
    const xpEvents = new FakeXpEventStore();
    xpEvents.purgeEndedBefore = async () => {
      throw new Error('connection terminated unexpectedly');
    };
    const { ctx, booked, logs } = scheduling();

    await createPruneHandler(activity.store, () => NOW, xpEvents)({}, ctx);

    expect(activity.prunes).toHaveLength(1);
    expect(booked).toEqual([nextRun]);
    expect(logs.some((line) => line.includes('connection terminated unexpectedly'))).toBe(true);
  });
});

describe('the leveling manifest', () => {
  test('arms the prune only when an activity store makes the prune schedule exist', () => {
    const withStore = createLevelingModule({ activity: recordingActivity().store });
    const without = createLevelingModule();

    expect(withStore.listeners?.length).toBe((without.listeners?.length ?? 0) + 1);

    const registry = new ModuleRegistry();
    registry.register(withStore);
    expect(registry.maySchedule('leveling', PRUNE_JOB_ID)).toBe(true);
  });

  test('binds the XP event store into the scheduled prune', async () => {
    const xpEvents = new FakeXpEventStore();
    const manifest = createLevelingModule({
      activity: recordingActivity().store,
      xpEvents,
      now: () => NOW,
    });
    const { ctx } = scheduling();

    await manifest.scheduledHandlers?.[PRUNE_JOB_ID]?.({}, ctx);

    expect(xpEvents.purges).toEqual([{ guildId: GUILD, before: NOW - XP_EVENT_RETENTION_MS }]);
  });
});
