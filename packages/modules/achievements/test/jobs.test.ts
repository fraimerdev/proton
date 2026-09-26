import { describe, expect, test } from 'bun:test';
import type { AchievementInput } from '../src/config.ts';
import {
  DAY_MS,
  handleConfigChanged,
  handleGuildAvailable,
  handleJobRequest,
  JOB_START_DELAY_MS,
  JOB_STOPPED_OFF,
  processRecords,
} from '../src/engine.ts';
import {
  ACHIEVEMENT_SCHEDULES,
  createScheduledHandlers,
  purgeAchievements,
  SWEEP_MIN_DELAY_MS,
} from '../src/jobs.ts';
import type { JobState } from '../src/store.ts';
import { ACTOR, CHANNEL, GUILD, HOUR, ROLE, T0, USER } from './contracts.ts';
import { event, failure, harness, subjects } from './fakes.ts';

type Harness = ReturnType<typeof harness>;

const MEMBER_LOOKUP = {
  memberFacts: async () => ({ roleIds: [], bot: false, joinedAt: null, premiumSince: null }),
};

const RISING_STAR: AchievementInput = {
  id: 'rising-star',
  name: 'Rising Star',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'level', trigger: 'leveling.level' }],
  tiers: [{ id: 'single', targets: { level: 5 } }],
};

const CHATTY: AchievementInput = {
  id: 'chatty',
  name: 'Chatty',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  tiers: [{ id: 'single', targets: { messages: 3 } }],
};

const ANNIVERSARY: AchievementInput = {
  id: 'anniversary',
  name: 'Anniversary',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'days', trigger: 'membership.days' }],
  tiers: [{ id: 'single', targets: { days: 30 } }],
};

function jobRequest(
  achievementId: string,
  job: 'rebuild' | 'rebuild_preview' | 'recheck',
  options: { announce?: boolean; acceptLoss?: boolean } = {},
) {
  return event('achievements.job_requested', {
    requestId: 'job-request-0001',
    guildId: GUILD,
    actorId: ACTOR,
    achievementId,
    job,
    announce: options.announce ?? false,
    acceptLoss: options.acceptLoss ?? false,
  });
}

async function runJob(h: Harness, achievementId: string): Promise<JobState | null> {
  const handlers = createScheduledHandlers(h.deps);

  for (let run = 0; run < 20; run++) {
    await handlers.job({ achievementId }, h.ctx);
    const state = await h.store.job(GUILD, achievementId);
    if (state?.status !== 'queued' && state?.status !== 'running') return state;
  }

  return h.store.job(GUILD, achievementId);
}

async function messages(h: Harness, count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await processRecords(h.ctx, h.deps, {
      records: [h.message(index)],
      subjects: subjects(),
      originChannelId: CHANNEL,
    });
  }
}

function configChanged(
  enabledBefore: boolean,
  enabledAfter: boolean,
  changedKeys: string[],
  at = T0,
) {
  return event(
    'proton.config_changed',
    {
      auditId: 'audit-1',
      guildId: GUILD,
      moduleId: 'achievements',
      actorId: ACTOR,
      source: 'dashboard',
      enabledBefore,
      enabledAfter,
      changedKeys,
    },
    at,
  );
}

describe('schedules', () => {
  test('declares one handler per schedule', () => {
    expect(Object.keys(createScheduledHandlers({})).sort()).toEqual(
      [...ACHIEVEMENT_SCHEDULES].sort(),
    );
  });

  test('purge delegates to the store’s retention', async () => {
    const h = harness({});
    expect(await purgeAchievements(h.store, T0)).toEqual({ activity: 0, seen: 0, facts: 0 });
  });
});

describe('sweep', () => {
  test('reschedules itself for the next due work and retires when there is none', async () => {
    const h = harness({
      achievements: [
        {
          ...CHATTY,
          tiers: [
            {
              id: 'single',
              targets: { messages: 1 },
              rewards: [{ kind: 'add_role', roleId: ROLE }],
            },
          ],
        },
      ],
    });
    h.executor.on(
      ({ kind }) => kind === 'add_role',
      failure('discord_503', 'Discord had a problem.'),
      1,
    );
    await messages(h, 1);

    const handlers = createScheduledHandlers(h.deps);
    h.scheduled.length = 0;

    await handlers.sweep({}, h.ctx);
    expect(h.scheduled).toEqual([
      {
        jobId: 'sweep',
        runAt: T0 + SWEEP_MIN_DELAY_MS,
        key: `sweep:${T0 + SWEEP_MIN_DELAY_MS}`,
        data: {},
        replace: false,
      },
    ]);

    h.advance(SWEEP_MIN_DELAY_MS);
    await handlers.sweep({}, h.ctx);
    h.advance(SWEEP_MIN_DELAY_MS);
    await handlers.sweep({}, h.ctx);
    expect(h.executor.of('send')).toHaveLength(1);

    h.scheduled.length = 0;
    const idle = harness({});
    await createScheduledHandlers(idle.deps).sweep({}, idle.ctx);
    expect(idle.scheduled).toEqual([]);
  });

  test('arms and reschedules under keys a running sweep cannot hold', async () => {
    const h = harness({
      achievements: [
        {
          ...CHATTY,
          tiers: [
            {
              id: 'single',
              targets: { messages: 1 },
              rewards: [{ kind: 'add_role', roleId: ROLE }],
            },
          ],
        },
      ],
    });
    h.executor.on(
      ({ kind }) => kind === 'add_role',
      failure('discord_503', 'Discord had a problem.'),
      1,
    );
    await messages(h, 1);

    expect(h.scheduled.filter(({ jobId }) => jobId === 'sweep')).toMatchObject([
      { key: `sweep:${T0 + 60_000}`, runAt: T0 + 60_000 },
    ]);

    h.advance(60_000);
    h.scheduled.length = 0;
    await createScheduledHandlers(h.deps).sweep({}, h.ctx);

    const [next] = h.scheduled;
    expect(next?.jobId).toBe('sweep');
    expect(next?.runAt).toBeGreaterThan(T0 + 60_000);
    expect(next?.key).toBe(`sweep:${next?.runAt}`);
  });
});

describe('config changes', () => {
  test('turning on arms the sweep and the daily check and queues the first re-check', async () => {
    const h = harness({ achievements: [RISING_STAR] });

    const outcome = await handleConfigChanged(
      h.ctx,
      h.deps,
      configChanged(false, true, ['enabled']),
    );
    expect(outcome).toEqual({ turnedOff: false, turnedOn: true });

    expect(
      h.scheduled.map(({ jobId, key, runAt, replace }) => [jobId, key, runAt, replace]),
    ).toEqual([
      ['job', 'rising-star', T0 + JOB_START_DELAY_MS, true],
      ['sweep', `sweep:${T0 + 60_000}`, T0 + 60_000, false],
      ['daily', 'daily', T0 + DAY_MS, false],
    ]);
    expect(await h.store.job(GUILD, 'rising-star')).toMatchObject({
      job: 'recheck',
      status: 'queued',
    });
  });

  test('turning off is reported so voice sessions close', async () => {
    const h = harness({ achievements: [RISING_STAR] });
    expect(
      await handleConfigChanged(h.ctx, h.deps, configChanged(true, false, ['enabled'])),
    ).toEqual({
      turnedOff: true,
      turnedOn: false,
    });
    expect(h.scheduled).toEqual([]);

    const other = event('proton.config_changed', {
      auditId: 'audit-2',
      guildId: GUILD,
      moduleId: 'leveling',
      actorId: ACTOR,
      source: 'dashboard',
      enabledBefore: true,
      enabledAfter: false,
      changedKeys: ['enabled'],
    });
    expect(await handleConfigChanged(h.ctx, h.deps, other)).toEqual({
      turnedOff: false,
      turnedOn: false,
    });
  });

  test('turning off fails the jobs it strands, so the next request is not refused', async () => {
    const h = harness({ achievements: [CHATTY, RISING_STAR] });
    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'rebuild'));
    await h.store.setJob(GUILD, 'chatty', { status: 'running', cursor: 'half-way' });
    await handleJobRequest(h.ctx, h.deps, jobRequest('rising-star', 'recheck'));

    h.configure({ enabled: false, achievements: [CHATTY, RISING_STAR] });
    await handleConfigChanged(h.ctx, h.deps, configChanged(true, false, ['enabled']));

    for (const achievementId of ['chatty', 'rising-star']) {
      expect(await h.store.job(GUILD, achievementId)).toMatchObject({
        status: 'failed',
        cursor: null,
        finishedAt: T0,
        result: { reason: JOB_STOPPED_OFF },
      });
    }
  });

  test('re-enabling re-checks a reopened state achievement, and only once per period', async () => {
    const h = harness({ achievements: [RISING_STAR, CHATTY] });
    const jobs = () => h.scheduled.filter(({ jobId }) => jobId === 'job');
    const flip = async (on: boolean, at: number) => {
      h.configure({ enabled: on, achievements: [RISING_STAR, CHATTY] });
      await handleConfigChanged(h.ctx, h.deps, configChanged(!on, on, ['enabled'], at));
    };

    await flip(true, T0);
    await runJob(h, 'rising-star');

    await flip(false, T0);
    h.advance(HOUR);
    h.scheduled.length = 0;
    await flip(true, T0 + HOUR);

    expect(jobs()).toMatchObject([
      { key: 'rising-star', runAt: T0 + HOUR + JOB_START_DELAY_MS, replace: true },
    ]);
    expect(await h.store.job(GUILD, 'rising-star')).toMatchObject({
      job: 'recheck',
      status: 'queued',
      requestedAt: T0 + HOUR,
    });
    await runJob(h, 'rising-star');

    await flip(false, T0 + HOUR);
    h.scheduled.length = 0;
    await flip(true, T0 + HOUR);
    expect(jobs()).toEqual([]);
  });

  test('guild.available repairs periods and arms the sweep and the daily check', async () => {
    const h = harness({ achievements: [CHATTY] });
    await handleGuildAvailable(h.ctx, h.deps, event('guild.available', {}));

    expect(h.scheduled.map(({ jobId }) => jobId)).toEqual(['sweep', 'daily']);
    const runtime = await h.store.runtime(GUILD);
    expect(runtime.periods.get('chatty')).toEqual([{ start: T0, end: null }]);
  });
});

describe('jobs', () => {
  test('a job request is queued and scheduled 15 seconds out', async () => {
    const h = harness({ achievements: [CHATTY] });
    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'recheck', { announce: true }));

    expect(await h.store.job(GUILD, 'chatty')).toMatchObject({
      job: 'recheck',
      status: 'queued',
      requestedBy: ACTOR,
      announce: true,
    });
    expect(h.scheduled).toEqual([
      {
        jobId: 'job',
        runAt: T0 + JOB_START_DELAY_MS,
        key: 'chatty',
        data: expect.objectContaining({ achievementId: 'chatty', job: 'recheck' }),
        replace: true,
      },
    ]);
  });

  test('a request while the module is off fails with the reason', async () => {
    const h = harness({ enabled: false, achievements: [CHATTY] });
    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'recheck'));

    const state = await h.store.job(GUILD, 'chatty');
    expect(state?.status).toBe('failed');
    expect(state?.result?.reason).toContain('Achievements is off');
    expect(h.scheduled).toEqual([]);
  });

  test('a re-check unlocks members already past a level, quietly', async () => {
    const h = harness(
      { achievements: [RISING_STAR] },
      {
        ...MEMBER_LOOKUP,
        levelHolders: async (_guildId, minLevel, after) =>
          after === null && minLevel === 5 ? [{ userId: USER, level: 7 }] : [],
      },
    );

    await handleJobRequest(h.ctx, h.deps, jobRequest('rising-star', 'recheck'));
    const state = await runJob(h, 'rising-star');

    expect(state).toMatchObject({ status: 'done', result: { members: 1 } });
    expect(state?.result?.newlyEarned.single).toBe(1);

    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ achievementId: 'rising-star', announceStatus: 'suppressed' });
    expect(h.executor.of('send')).toEqual([]);
  });

  test('a rebuild that would lose progress is refused unless the loss is accepted', async () => {
    const h = harness({
      achievements: [{ ...CHATTY, tiers: [{ id: 'single', targets: { messages: 100 } }] }],
    });
    await messages(h, 3);

    h.configure({
      achievements: [
        {
          ...CHATTY,
          tiers: [{ id: 'single', targets: { messages: 100 } }],
          startsAt: new Date(T0 + 2 * HOUR).toISOString(),
        },
      ],
    });

    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'rebuild'));
    let state = await runJob(h, 'chatty');
    expect(state?.status).toBe('failed');
    expect(state?.result?.reason).toContain('1 member would lose progress');

    let [progress] = await h.store.memberStates(GUILD, USER, ['chatty']);
    expect(progress?.values.messages?.value).toBe(3);

    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'rebuild', { acceptLoss: true }));
    state = await runJob(h, 'chatty');
    expect(state).toMatchObject({ status: 'done', result: { members: 1, lost: 1 } });

    [progress] = await h.store.memberStates(GUILD, USER, ['chatty']);
    expect(progress?.values.messages?.value).toBe(0);
  });

  test('turning on an achievement that includes recorded activity rebuilds it and unlocks', async () => {
    const h = harness({ achievements: [{ ...CHATTY, status: 'draft' }] }, MEMBER_LOOKUP);
    await messages(h, 3);
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);

    h.configure({ achievements: [{ ...CHATTY, includeRecorded: true }] });
    await handleConfigChanged(h.ctx, h.deps, configChanged(true, true, ['achievements']));
    expect(await h.store.job(GUILD, 'chatty')).toMatchObject({ job: 'rebuild', status: 'queued' });

    const state = await runJob(h, 'chatty');
    expect(state).toMatchObject({ status: 'done', result: { members: 1, changed: 1, lost: 0 } });

    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ achievementId: 'chatty', announceStatus: 'suppressed' });
  });

  test('a rebuild preview reports without writing', async () => {
    const h = harness({ achievements: [{ ...CHATTY, status: 'draft' }] });
    await messages(h, 2);
    h.configure({ achievements: [{ ...CHATTY, includeRecorded: true }] });

    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'rebuild_preview'));
    const state = await runJob(h, 'chatty');

    expect(state).toMatchObject({ status: 'done', result: { members: 1, changed: 1, lost: 0 } });
    const [progress] = await h.store.memberStates(GUILD, USER, ['chatty']);
    expect(progress?.values.messages).toBeUndefined();
  });

  test('a scheduled achievement’s first re-check waits for its start date, then backfills', async () => {
    const startsAt = new Date(T0 + 2 * DAY_MS).toISOString();
    const h = harness(
      { achievements: [{ ...RISING_STAR, startsAt }] },
      {
        ...MEMBER_LOOKUP,
        levelHolders: async (_guildId, minLevel, after) =>
          after === null && minLevel === 5 ? [{ userId: USER, level: 30 }] : [],
      },
    );

    await handleConfigChanged(h.ctx, h.deps, configChanged(false, true, ['enabled']));
    expect(h.scheduled.filter(({ jobId }) => jobId === 'job')).toMatchObject([
      { key: 'rising-star', runAt: T0 + 2 * DAY_MS + JOB_START_DELAY_MS },
    ]);

    h.scheduled.length = 0;
    await createScheduledHandlers(h.deps).job({ achievementId: 'rising-star' }, h.ctx);

    expect(await h.store.job(GUILD, 'rising-star')).toMatchObject({ status: 'queued' });
    expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);
    expect(h.scheduled).toMatchObject([
      { jobId: 'job', key: 'rising-star', runAt: T0 + 2 * DAY_MS + JOB_START_DELAY_MS },
    ]);

    h.advance(2 * DAY_MS + JOB_START_DELAY_MS);
    const state = await runJob(h, 'rising-star');

    expect(state).toMatchObject({ status: 'done', result: { members: 1 } });
    expect(state?.result?.newlyEarned.single).toBe(1);
    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ achievementId: 'rising-star', progress: { level: 30 } });
  });

  test('a job for an achievement that was deleted fails with the reason', async () => {
    const h = harness({ achievements: [CHATTY] });
    await handleJobRequest(h.ctx, h.deps, jobRequest('chatty', 'recheck'));
    h.configure({ achievements: [] });

    const state = await runJob(h, 'chatty');
    expect(state?.status).toBe('failed');
    expect(state?.result?.reason).toContain('no longer in this server’s settings');
  });
});

describe('daily', () => {
  test('unlocks anniversaries, prunes unused badges and re-arms itself', async () => {
    const h = harness(
      { achievements: [{ ...ANNIVERSARY, badge: { assetId: 'keepme0001' } }] },
      MEMBER_LOOKUP,
    );
    await h.store.upsertFacts(GUILD, USER, { joinedAt: T0 - 30 * DAY_MS - HOUR, leftAt: null });

    const badge = (assetId: string) => ({
      assetId,
      contentType: 'image/png',
      base64: 'iVBORw0KGgo=',
      byteSize: 8,
      uploadedBy: ACTOR,
      uploadedAt: T0 - 2 * DAY_MS,
    });
    await h.store.putBadge(GUILD, badge('keepme0001'));
    await h.store.putBadge(GUILD, badge('dropme0001'));

    await createScheduledHandlers(h.deps).daily({}, h.ctx);

    const [row] = await h.store.unlocksOf(GUILD, USER);
    expect(row).toMatchObject({ achievementId: 'anniversary', progress: { days: 30 } });
    expect(await h.store.anniversaryRunAt(GUILD)).toBe(T0);
    expect(await h.store.badge(GUILD, 'keepme0001')).not.toBeNull();
    expect(await h.store.badge(GUILD, 'dropme0001')).toBeNull();
    expect(h.scheduled.at(-1)).toEqual({
      jobId: 'daily',
      runAt: T0 + DAY_MS,
      key: 'daily',
      data: {},
      replace: false,
    });
  });

  test('re-queues a start date whose re-check was lost, and leaves a finished one alone', async () => {
    const startsAt = new Date(T0 + 12 * HOUR).toISOString();
    const scheduled = () =>
      harness(
        { achievements: [{ ...RISING_STAR, startsAt }] },
        {
          ...MEMBER_LOOKUP,
          levelHolders: async (_guildId, minLevel, after) =>
            after === null && minLevel === 5 ? [{ userId: USER, level: 30 }] : [],
        },
      );
    const jobs = (h: Harness) => h.scheduled.filter(({ jobId }) => jobId === 'job');

    const lost = scheduled();
    await createScheduledHandlers(lost.deps).daily({}, lost.ctx);
    expect(jobs(lost)).toMatchObject([
      { key: 'rising-star', runAt: T0 + 12 * HOUR + JOB_START_DELAY_MS },
    ]);

    lost.advance(DAY_MS);
    lost.scheduled.length = 0;
    await createScheduledHandlers(lost.deps).daily({}, lost.ctx);

    expect(jobs(lost)).toMatchObject([
      { key: 'rising-star', runAt: T0 + DAY_MS + JOB_START_DELAY_MS },
    ]);
    expect(await runJob(lost, 'rising-star')).toMatchObject({ status: 'done' });
    expect(await lost.store.unlocksOf(GUILD, USER)).toHaveLength(1);

    const ran = scheduled();
    await createScheduledHandlers(ran.deps).daily({}, ran.ctx);
    ran.advance(12 * HOUR + JOB_START_DELAY_MS);
    await runJob(ran, 'rising-star');

    ran.advance(DAY_MS - 12 * HOUR);
    ran.scheduled.length = 0;
    await createScheduledHandlers(ran.deps).daily({}, ran.ctx);
    expect(jobs(ran)).toEqual([]);
  });
});
