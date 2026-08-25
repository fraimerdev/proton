import { describe, expect, test } from 'bun:test';
import { type ModuleContext, ProviderRegistry } from '@proton/core';
import { canManage } from '../src/authorize.ts';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import { drawGiveaway } from '../src/end.ts';
import {
  editGiveawayFields,
  type ManageDeps,
  pauseGiveaway,
  resumeGiveaway,
  shiftDeadline,
} from '../src/manage.ts';
import { END_JOB_ID } from '../src/schedule.ts';
import type { CreateGiveawayInput, Giveaway } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const HOST = '400000000000000001';
const STRANGER = '400000000000000099';
const MANAGER_ROLE = '600000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

interface Harness {
  ctx: ModuleContext<GiveawaysConfig>;
  scheduled: { jobId: string; runAt: Date; replace: boolean }[];
  edits: string[];
}

function harness(_clock: { now: number }, config: Partial<GiveawaysConfig> = {}): Harness {
  const scheduled: Harness['scheduled'] = [];
  const edits: string[] = [];

  const ctx = {
    guildId: GUILD,
    config: { ...giveawaysConfigSchema.parse({}), enabled: true, ...config },
    tier: 'free',
    executor: {
      async execute(request: { kind: string; idempotencyKey?: string }) {
        edits.push(request.idempotencyKey ?? request.kind);
        return { status: 'executed' };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    async schedule(
      jobId: string,
      runAt: Date,
      _key: string,
      _data: unknown,
      options?: { replace?: boolean },
    ) {
      scheduled.push({ jobId, runAt, replace: options?.replace === true });
      return { scheduled: true, replaced: false };
    },
    async cancel() {},
  } as unknown as ModuleContext<GiveawaysConfig>;

  return { ctx, scheduled, edits };
}

async function seeded(clock: { now: number }, over: Partial<CreateGiveawayInput> = {}) {
  const store = new MemoryGiveawayStore();

  const giveaway = await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(clock.now + 4 * HOUR),
    createdBy: HOST,
    verifyOn: 'join',
    ...over,
  } satisfies CreateGiveawayInput);

  const deps: ManageDeps = {
    store,
    providers: new ProviderRegistry(),
    now: () => clock.now,
  };

  return { store, giveaway, deps };
}

describe('pause holds the remaining time', () => {
  test('pausing closes entries and records who did it', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    const outcome = await pauseGiveaway(h.ctx, deps, {
      giveawayId: 'g1',
      by: HOST,
      reason: 'prize fell through',
    });

    expect(outcome.outcome).toBe('ok');

    const row = await store.get(GUILD, 'g1');
    expect(row?.status).toBe('paused');
    expect(row?.pausedBy).toBe(HOST);
    expect(row?.pauseReason).toBe('prize fell through');
  });

  test('a paused giveaway refuses entries at the store level', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    await pauseGiveaway(harness(clock).ctx, deps, { giveawayId: 'g1', by: HOST });

    const entered = await store.enter({
      giveawayId: 'g1',
      userId: STRANGER,
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });

    expect(entered).toBe('closed');
  });

  // The whole point of a pause: a member who had three hours left before it must have three hours
  // left after it, however long the pause ran.
  test('resume pushes the deadline by exactly the time spent paused', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    const before = (await store.get(GUILD, 'g1'))?.endsAt.getTime() ?? 0;

    await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });
    clock.now += 90 * 60 * 1000;
    await resumeGiveaway(h.ctx, deps, { giveawayId: 'g1' });

    const after = await store.get(GUILD, 'g1');

    expect(after?.status).toBe('running');
    expect((after?.endsAt.getTime() ?? 0) - before).toBe(90 * 60 * 1000);
    expect(after?.pausedAt).toBeNull();
  });

  test('two pauses accumulate rather than the second overwriting the first', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    const before = (await store.get(GUILD, 'g1'))?.endsAt.getTime() ?? 0;

    for (const held of [30, 45]) {
      await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });
      clock.now += held * 60 * 1000;
      await resumeGiveaway(h.ctx, deps, { giveawayId: 'g1' });
    }

    const after = await store.get(GUILD, 'g1');

    expect((after?.endsAt.getTime() ?? 0) - before).toBe(75 * 60 * 1000);
    expect(after?.pausedMs).toBe(75 * 60 * 1000);
  });

  test('resume reschedules the draw, replacing the old job', async () => {
    const clock = { now: NOW.getTime() };
    const { deps } = await seeded(clock);
    const h = harness(clock);

    await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });
    clock.now += HOUR;
    await resumeGiveaway(h.ctx, deps, { giveawayId: 'g1' });

    const end = h.scheduled.filter((row) => row.jobId === END_JOB_ID);

    expect(end).toHaveLength(1);
    // Without replace the giveaway still fires at the pre-pause deadline, and the pause is a lie.
    expect(end[0]?.replace).toBe(true);
    expect(end[0]?.runAt.getTime()).toBe(NOW.getTime() + 5 * HOUR);
  });

  test('pausing something that is not running is refused', async () => {
    const clock = { now: NOW.getTime() };
    const { deps } = await seeded(clock);
    const h = harness(clock);

    await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });
    const second = await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });

    expect(second.outcome).toBe('wrong-state');
  });

  test('resuming something that is not paused is refused', async () => {
    const clock = { now: NOW.getTime() };
    const { deps } = await seeded(clock);

    const outcome = await resumeGiveaway(harness(clock).ctx, deps, { giveawayId: 'g1' });

    expect(outcome.outcome).toBe('wrong-state');
  });

  test('a giveaway that does not exist reports missing, not wrong-state', async () => {
    const clock = { now: NOW.getTime() };
    const { deps } = await seeded(clock);

    const outcome = await pauseGiveaway(harness(clock).ctx, deps, { giveawayId: 'nope', by: HOST });

    expect(outcome.outcome).toBe('missing');
  });
});

describe('extend and shorten move the persisted deadline', () => {
  test('extending moves ends_at and reschedules', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    const outcome = await shiftDeadline(h.ctx, deps, { giveawayId: 'g1', byMs: 2 * HOUR });

    expect(outcome.outcome).toBe('ok');
    expect((await store.get(GUILD, 'g1'))?.endsAt.getTime()).toBe(NOW.getTime() + 6 * HOUR);
    expect(h.scheduled.some((row) => row.jobId === END_JOB_ID && row.replace)).toBe(true);
  });

  test('shortening moves it the other way', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);

    await shiftDeadline(harness(clock).ctx, deps, { giveawayId: 'g1', byMs: -2 * HOUR });

    expect((await store.get(GUILD, 'g1'))?.endsAt.getTime()).toBe(NOW.getTime() + 2 * HOUR);
  });

  // "shorten by 3 days" on a giveaway with four hours left is a typo far more often than an
  // instruction, and silently drawing it cannot be undone.
  test('shortening past the present is refused rather than drawing immediately', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);

    const outcome = await shiftDeadline(harness(clock).ctx, deps, {
      giveawayId: 'g1',
      byMs: -5 * HOUR,
    });

    expect(outcome.outcome).toBe('too-short');
    expect((await store.get(GUILD, 'g1'))?.endsAt.getTime()).toBe(NOW.getTime() + 4 * HOUR);
  });

  test('an ended giveaway cannot be extended back to life', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    await store.finishDraw(GUILD, 'g1', ['running'], 'ended', new Date(clock.now));

    const outcome = await shiftDeadline(harness(clock).ctx, deps, {
      giveawayId: 'g1',
      byMs: HOUR,
    });

    expect(outcome.outcome).toBe('wrong-state');
  });

  test('a paused giveaway can still be extended', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });
    const outcome = await shiftDeadline(h.ctx, deps, { giveawayId: 'g1', byMs: HOUR });

    expect(outcome.outcome).toBe('ok');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('paused');
  });
});

describe('editing a live giveaway', () => {
  test('the fields change and the original message is edited, not replaced', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    const outcome = await editGiveawayFields(h.ctx, deps, {
      giveawayId: 'g1',
      patch: { title: 'A better prize', winnerCount: 3 },
    });

    expect(outcome.outcome).toBe('ok');

    const row = await store.get(GUILD, 'g1');
    expect(row?.title).toBe('A better prize');
    expect(row?.winnerCount).toBe(3);
    expect(row?.messageId).toBe('700000000000000000');
    expect(h.edits).toHaveLength(1);
  });

  test('editing the deadline reschedules the draw too', async () => {
    const clock = { now: NOW.getTime() };
    const { deps } = await seeded(clock);
    const h = harness(clock);

    await editGiveawayFields(h.ctx, deps, {
      giveawayId: 'g1',
      patch: { endsAt: new Date(clock.now + 9 * HOUR) },
    });

    expect(h.scheduled.some((row) => row.jobId === END_JOB_ID && row.replace)).toBe(true);
  });

  test('an edit that names nothing changes nothing', async () => {
    const clock = { now: NOW.getTime() };
    const { deps } = await seeded(clock);

    const outcome = await editGiveawayFields(harness(clock).ctx, deps, {
      giveawayId: 'g1',
      patch: {},
    });

    expect(outcome.outcome).toBe('wrong-state');
  });

  test('a cancelled giveaway cannot be edited', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    await store.finishDraw(GUILD, 'g1', ['running'], 'cancelled', new Date(clock.now));

    const outcome = await editGiveawayFields(harness(clock).ctx, deps, {
      giveawayId: 'g1',
      patch: { title: 'nope' },
    });

    expect(outcome.outcome).toBe('wrong-state');
  });
});

describe('scheduled giveaways', () => {
  async function scheduled(clock: { now: number }) {
    return seeded(clock, {
      status: 'scheduled',
      startsAt: new Date(clock.now + HOUR),
      endsAt: new Date(clock.now + 5 * HOUR),
    });
  }

  test('a scheduled giveaway takes no entries before it starts', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await scheduled(clock);

    const entered = await store.enter({
      giveawayId: 'g1',
      userId: STRANGER,
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });

    expect(entered).toBe('closed');
  });

  test('activation flips it to running and opens entries', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await scheduled(clock);

    clock.now += HOUR;
    const started = await store.activate(GUILD, 'g1', new Date(clock.now));

    expect(started?.status).toBe('running');
    expect(
      await store.enter({
        giveawayId: 'g1',
        userId: STRANGER,
        baseEntries: 1,
        totalEntries: 1,
        breakdown: [],
        memberSnapshot: null,
      }),
    ).toBe('entered');
  });

  // Two workers picking up the same start job must not both post and both arm the draw.
  test('activating twice yields exactly one activation', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await scheduled(clock);
    const at = new Date(clock.now + HOUR);

    const [first, second] = await Promise.all([
      store.activate(GUILD, 'g1', at),
      store.activate(GUILD, 'g1', at),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  test('dueToStart finds it only once its start time has passed', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await scheduled(clock);

    expect(await store.dueToStart(GUILD, new Date(clock.now), 10)).toHaveLength(0);
    expect(await store.dueToStart(GUILD, new Date(clock.now + HOUR), 10)).toHaveLength(1);
  });

  test('a scheduled giveaway that never started is cancellable', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await scheduled(clock);

    expect(await store.finishDraw(GUILD, 'g1', ['scheduled'], 'cancelled', new Date())).toBe(true);
  });

  test('a scheduled giveaway is never drawn while it is still scheduled', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await scheduled(clock);

    const drawn = await drawGiveaway(
      { store, providers: new ProviderRegistry(), now: () => clock.now },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: 'proton:schedule' },
    );

    expect(drawn.outcome).toBe('already-ended');
    expect(store.drawRows).toHaveLength(0);
  });
});

describe('who may manage a giveaway', () => {
  const config = { ...giveawaysConfigSchema.parse({}), managerRoleIds: [MANAGER_ROLE] };

  const giveaway = { hostId: HOST, createdBy: HOST } as Giveaway;

  test('the host always may', () => {
    expect(canManage(config, { userId: HOST }, giveaway)).toBe(true);
  });

  test('a stranger with no manager role may not', () => {
    expect(canManage(config, { userId: STRANGER, roleIds: [] }, giveaway)).toBe(false);
  });

  test('a manager role may act on somebody else’s giveaway', () => {
    expect(canManage(config, { userId: STRANGER, roleIds: [MANAGER_ROLE] }, giveaway)).toBe(true);
  });

  // actorRoleIds is optional on CommandContext, so the check has to work when it is absent
  // rather than throwing or silently granting.
  test('a missing role list denies rather than grants', () => {
    expect(canManage(config, { userId: STRANGER }, giveaway)).toBe(false);
  });

  test('with no manager roles configured, only the host may', () => {
    const bare = giveawaysConfigSchema.parse({});

    expect(canManage(bare, { userId: HOST }, giveaway)).toBe(true);
    expect(canManage(bare, { userId: STRANGER, roleIds: [MANAGER_ROLE] }, giveaway)).toBe(false);
  });
});
