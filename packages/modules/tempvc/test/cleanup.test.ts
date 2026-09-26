import { describe, expect, test } from 'bun:test';
import {
  armPatrol,
  DELETE_ATTEMPTS,
  PATROL_INTERVAL_MS,
  PATROL_KEY,
  patrol,
  sweep,
} from '../src/cleanup.ts';
import type { PresenceStore } from '../src/store.ts';
import { callsOf, GUILD, harness, member } from './harness.ts';

const NOW = new Date('2026-08-23T12:00:00Z');
const LATER = new Date(NOW.getTime() + 10_000);

function presence(occupants: string[] = []): PresenceStore {
  const refusals = new Map<string, number>();

  return {
    locate: async () => null,
    where: async () => null,
    place: async () => undefined,
    enter: async () => occupants.length,
    leave: async () => occupants.length,
    occupants: async () => occupants,
    reset: async () => undefined,
    refusedDelete: async (_guildId, rowId) => {
      refusals.set(rowId, (refusals.get(rowId) ?? 0) + 1);
      return refusals.get(rowId) ?? 0;
    },
    deleteRefusals: async (_guildId, rowId) => refusals.get(rowId) ?? 0,
  };
}

async function emptied(occupants: string[] = []) {
  const fake = harness({ now: () => NOW });
  const outcome = await fake.service.create(fake.ctx, fake.hub, member());
  if (!('created' in outcome)) throw new Error('expected a channel');

  await fake.service.scheduleDelete(fake.ctx, fake.hub, outcome.created);
  fake.calls.length = 0;

  return {
    fake,
    row: outcome.created,
    deps: {
      repository: fake.repository,
      presence: presence(occupants),
      botUserId: '300000000000000000',
    },
  };
}

describe('the deferred delete', () => {
  test('a channel still empty at the deadline is deleted', async () => {
    const { fake, deps } = await emptied();

    const report = await sweep(fake.ctx, deps, undefined, LATER);

    expect(report.deleted).toBe(1);
    expect(callsOf(fake, 'delete_channel')).toHaveLength(1);
    expect(fake.repository.rows.size).toBe(0);
  });

  /**
   * The whole reason the delete is deferred. Discord fires leave-then-join whenever a member
   * switches channel, so occupancy is re-read at the deadline rather than trusted from when it
   * was written.
   */
  test('a channel somebody walked back into is spared, not deleted', async () => {
    const { fake, row, deps } = await emptied(['700000000000000002']);

    const report = await sweep(fake.ctx, deps, undefined, LATER);

    expect(report).toMatchObject({ deleted: 0, spared: 1 });
    expect(callsOf(fake, 'delete_channel')).toHaveLength(0);
    expect(fake.repository.rows.get(row.id)?.deleteAfter).toBeNull();
  });

  test('nothing is deleted before the deadline arrives', async () => {
    const { fake, deps } = await emptied();

    const report = await sweep(fake.ctx, deps, undefined, NOW);

    expect(report.deleted).toBe(0);
    expect(callsOf(fake, 'delete_channel')).toHaveLength(0);
  });

  test('a delete Discord refuses goes back to live, and the patrol tries it again', async () => {
    const { fake, row, deps } = await emptied();
    fake.refuse('delete_channel', 'discord_403', 'Discord refused.', 'failed_api');

    expect(await sweep(fake.ctx, deps, row.id, LATER)).toMatchObject({ deleted: 0 });
    expect(fake.row(row.id)).toMatchObject({ status: 'live', deleteAfter: null });

    await patrol(fake.ctx, deps, LATER);
    expect(fake.row(row.id).deleteAfter).not.toBeNull();

    const report = await sweep(fake.ctx, deps, undefined, new Date(LATER.getTime() + 120_000));

    expect(report.deleted).toBe(1);
    expect(callsOf(fake, 'delete_channel')).toHaveLength(2);
    expect(fake.repository.rows.size).toBe(0);
  });

  test('a patrol that ran while the delete was in flight does not strand the row', async () => {
    const { fake, row, deps } = await emptied();

    const scheduled: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inner = fake.ctx.executor;
    const ctx = {
      ...fake.ctx,
      schedule: async (_jobId: string, _runAt: Date, naturalKey: string) => {
        scheduled.push(naturalKey);
        return { scheduled: true, replaced: false };
      },
      executor: {
        ...inner,
        async execute(request: Parameters<typeof inner.execute>[0]) {
          if (request.kind !== 'delete_channel') return inner.execute(request);

          await gate;
          return {
            status: 'failed_api' as const,
            failure: { code: 'discord_403', humanReason: 'Discord refused.' },
          };
        },
      },
    };

    const deleting = sweep(ctx, deps, row.id, LATER);
    await Bun.sleep(5);

    await patrol(ctx, deps, LATER);
    expect(scheduled).not.toContain(PATROL_KEY);

    release();
    await deleting;

    expect(fake.row(row.id)).toMatchObject({ status: 'live', deleteAfter: null });
    expect(scheduled).toContain(PATROL_KEY);
  });

  test('a delete Discord keeps refusing is retried a bounded number of times', async () => {
    const { fake, row, deps } = await emptied();

    let now = LATER.getTime();
    for (let round = 0; round < 4 * DELETE_ATTEMPTS; round += 1) {
      fake.refuse('delete_channel', 'discord_403', 'Discord refused.', 'failed_api');
      await patrol(fake.ctx, deps, new Date(now));
      now += 2 * PATROL_INTERVAL_MS;
    }

    expect(callsOf(fake, 'delete_channel')).toHaveLength(DELETE_ATTEMPTS);
    expect(fake.row(row.id)).toMatchObject({ status: 'live', deleteAfter: null });
    expect(
      fake.logs.filter((entry) => entry.message.includes('will not try again on its own')),
    ).toHaveLength(1);
  });

  test('a channel with no deadline is left alone entirely', async () => {
    const fake = harness({ now: () => NOW });
    await fake.service.create(fake.ctx, fake.hub, member());
    fake.calls.length = 0;

    const report = await sweep(
      fake.ctx,
      { repository: fake.repository, presence: presence(), botUserId: '300000000000000000' },
      undefined,
      LATER,
    );

    expect(report).toMatchObject({ deleted: 0, spared: 0, forgotten: 0 });
  });
});

describe('sweeping one row', () => {
  test('the job armed at the deadline sweeps only its own channel', async () => {
    const { fake, row, deps } = await emptied();

    const report = await sweep(fake.ctx, deps, row.id, LATER);

    expect(report.deleted).toBe(1);
  });

  test('a job for a row that has since been cancelled does nothing', async () => {
    const { fake, row, deps } = await emptied();
    await fake.repository.cancelDelete(row.id);

    const report = await sweep(fake.ctx, deps, row.id, LATER);

    expect(report).toMatchObject({ deleted: 0, spared: 0 });
    expect(callsOf(fake, 'delete_channel')).toHaveLength(0);
  });

  test('a job for a row that is already gone does nothing', async () => {
    const { fake, row, deps } = await emptied();
    await fake.repository.forget(row.id);

    expect(await sweep(fake.ctx, deps, row.id, LATER)).toMatchObject({ deleted: 0 });
  });
});

describe('the sweeper does not run half-wired', () => {
  test('an unbound module sweeps nothing rather than throwing', async () => {
    const { fake } = await emptied();

    const report = await sweep(fake.ctx, { repository: fake.repository }, undefined, LATER);

    expect(report).toMatchObject({ deleted: 0, spared: 0, forgotten: 0 });
  });
});

describe('guild scoping', () => {
  test('a sweep reads occupancy for the guild it is running in', async () => {
    const { fake, deps } = await emptied();

    expect(fake.ctx.guildId).toBe(GUILD);
    expect(await deps.presence.occupants(GUILD, 'x')).toEqual([]);
  });
});

describe('the rolling patrol', () => {
  /**
   * The gap the audit found: a channel that emptied while the worker was down fired no event, so
   * no deadline was written and no per-row job exists. `guild.available` catches it only on a fresh
   * gateway IDENTIFY, which a worker restart never triggers.
   */
  test('gives a channel that emptied while nobody was watching a deadline', async () => {
    const fake = harness({ now: () => NOW });
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    // No scheduleDelete was ever called — this is the state a restart leaves behind.
    expect(fake.row(outcome.created.id).deleteAfter).toBeNull();

    await patrol(
      fake.ctx,
      { repository: fake.repository, presence: presence(), botUserId: '300000000000000000' },
      NOW,
    );

    expect(fake.row(outcome.created.id).deleteAfter).not.toBeNull();
  });

  test('leaves an occupied channel alone', async () => {
    const fake = harness({ now: () => NOW });
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    await patrol(
      fake.ctx,
      {
        repository: fake.repository,
        presence: presence(['700000000000000002']),
        botUserId: '300000000000000000',
      },
      NOW,
    );

    expect(fake.row(outcome.created.id).deleteAfter).toBeNull();
  });

  test('forgets a reservation that never became a channel', async () => {
    const fake = harness({ now: () => NOW });
    await fake.repository.reserve({
      id: 'stranded',
      guildId: GUILD,
      hubChannelId: '500000000000000001',
      ownerId: '700000000000000001',
      maxChannelsPerUser: 1,
    });

    const later = new Date(NOW.getTime() + 120_000);
    await patrol(
      fake.ctx,
      { repository: fake.repository, presence: presence(), botUserId: '300000000000000000' },
      later,
    );

    expect(await fake.repository.byId('stranded')).toBeNull();
  });

  test('a reservation made moments ago is still in flight and is left alone', async () => {
    const fake = harness({ now: () => NOW });
    await fake.repository.reserve({
      id: 'in-flight',
      guildId: GUILD,
      hubChannelId: '500000000000000001',
      ownerId: '700000000000000001',
      maxChannelsPerUser: 1,
    });

    await patrol(
      fake.ctx,
      { repository: fake.repository, presence: presence(), botUserId: '300000000000000000' },
      NOW,
    );

    expect(await fake.repository.byId('in-flight')).not.toBeNull();
  });

  test('it stops itself once the guild has nothing left to patrol', async () => {
    const fake = harness({ now: () => NOW });
    const deps = {
      repository: fake.repository,
      presence: presence(),
      botUserId: '300000000000000000',
    };

    expect(await armPatrol(fake.ctx, deps, NOW)).toBe(false);

    await fake.service.create(fake.ctx, fake.hub, member());
    expect(await armPatrol(fake.ctx, deps, NOW)).toBe(true);
  });
});
