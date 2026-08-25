import { describe, expect, test } from 'bun:test';
import { type ModuleContext, ProviderRegistry } from '@proton/core';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import { MemoryDirtyCounts } from '../src/counter.ts';
import type { GiveawaysDeps } from '../src/deps.ts';
import { reconcile } from '../src/reconcile.ts';
import {
  armPatrols,
  CLAIM_JOB_ID,
  CLAIM_KEY,
  createClaimHandler,
  createFlushHandler,
  createReconcileHandler,
  FLUSH_JOB_ID,
  FLUSH_KEY,
  RECONCILE_JOB_ID,
  RECONCILE_KEY,
} from '../src/schedule.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD_A = '100000000000000000';
const GUILD_B = '200000000000000000';
const NOW = new Date('2026-08-25T12:00:00.000Z');

interface Scheduled {
  jobId: string;
  runAt: Date;
  naturalKey: string;
}

interface Harness {
  ctx: ModuleContext<GiveawaysConfig>;
  scheduled: Scheduled[];
  cancelled: { jobId: string; naturalKey: string }[];
  edits: string[];
}

function harness(
  options: { guildId?: string; enabled?: boolean; now?: () => number; failEdits?: boolean } = {},
): Harness {
  const scheduled: Scheduled[] = [];
  const cancelled: { jobId: string; naturalKey: string }[] = [];
  const edits: string[] = [];

  const config: GiveawaysConfig = {
    ...giveawaysConfigSchema.parse({}),
    enabled: options.enabled ?? true,
  };

  const ctx = {
    guildId: options.guildId ?? GUILD_A,
    config,
    tier: 'free',
    executor: {
      async execute(request: { kind: string; idempotencyKey?: string }) {
        if (options.failEdits) throw new Error('discord refused the edit');
        edits.push(request.idempotencyKey ?? request.kind);
        return { status: 'executed' };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    async schedule(jobId: string, runAt: Date, naturalKey: string) {
      scheduled.push({ jobId, runAt, naturalKey });
      return { scheduled: true, replaced: false };
    },
    async cancel(jobId: string, naturalKey: string) {
      cancelled.push({ jobId, naturalKey });
    },
  } as unknown as ModuleContext<GiveawaysConfig>;

  return { ctx, scheduled, cancelled, edits };
}

function deps(store: MemoryGiveawayStore, extra: Partial<GiveawaysDeps> = {}): GiveawaysDeps {
  return {
    store,
    providers: new ProviderRegistry(),
    now: () => NOW.getTime(),
    ...extra,
  };
}

function giveaway(id: string, guildId: string, over: Partial<CreateGiveawayInput> = {}) {
  return {
    id,
    guildId,
    channelId: '300000000000000000',
    messageId: `msg-${id}`,
    hostId: '400000000000000000',
    title: `Prize ${id}`,
    winnerCount: 1,
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: '400000000000000000',
    ...over,
  } satisfies CreateGiveawayInput;
}

describe('patrol arming', () => {
  // The bug this whole suite exists for: the manifest declared four schedules and only ever wrote
  // one, so live counts, crash recovery and claim expiry were all dead code in production.
  test('arming writes all three patrols', async () => {
    const h = harness();

    await expect(armPatrols(h.ctx, {}, NOW.getTime())).resolves.toBe(true);

    expect(h.scheduled.map((row) => row.jobId).sort()).toEqual(
      [CLAIM_JOB_ID, FLUSH_JOB_ID, RECONCILE_JOB_ID].sort(),
    );
    expect(h.scheduled.map((row) => row.naturalKey).sort()).toEqual(
      [CLAIM_KEY, FLUSH_KEY, RECONCILE_KEY].sort(),
    );
    expect(h.scheduled.every((row) => row.runAt.getTime() > NOW.getTime())).toBe(true);
  });

  test('a disabled module cancels its patrols instead of arming them', async () => {
    const h = harness({ enabled: false });

    await expect(armPatrols(h.ctx, {}, NOW.getTime())).resolves.toBe(false);

    expect(h.scheduled).toEqual([]);
    expect(h.cancelled.map((row) => row.jobId).sort()).toEqual(
      [CLAIM_JOB_ID, FLUSH_JOB_ID, RECONCILE_JOB_ID].sort(),
    );
  });

  test('each patrol re-arms itself, so one tick is not the last tick', async () => {
    const store = new MemoryGiveawayStore();
    const d = deps(store, { dirty: new MemoryDirtyCounts(() => NOW.getTime()) });

    for (const [jobId, handler] of [
      [FLUSH_JOB_ID, createFlushHandler(d)],
      [RECONCILE_JOB_ID, createReconcileHandler(d)],
      [CLAIM_JOB_ID, createClaimHandler(d)],
    ] as const) {
      const h = harness();
      await handler({}, h.ctx);

      expect(h.scheduled.map((row) => row.jobId)).toEqual([jobId]);
    }
  });

  test('the flush patrol re-arms even when the edit throws', async () => {
    const store = new MemoryGiveawayStore();
    const dirty = new MemoryDirtyCounts(() => NOW.getTime());
    await store.create(giveaway('g1', GUILD_A));
    await dirty.mark(GUILD_A, 'g1');

    const h = harness({ failEdits: true });

    // The error still surfaces to the scheduler — what must not happen is the patrol quietly
    // never running again because the re-arm sat after the throw.
    await expect(createFlushHandler(deps(store, { dirty }))({}, h.ctx)).rejects.toThrow(
      'discord refused the edit',
    );

    expect(h.scheduled.map((row) => row.jobId)).toEqual([FLUSH_JOB_ID]);
  });
});

describe('guild isolation', () => {
  test('a guild-A reconcile tick never reports a guild-B giveaway', async () => {
    const store = new MemoryGiveawayStore();
    await store.create(giveaway('a1', GUILD_A, { endsAt: new Date(NOW.getTime() - 60_000) }));
    await store.create(giveaway('b1', GUILD_B, { endsAt: new Date(NOW.getTime() - 60_000) }));

    const result = await reconcile({ store, guildId: GUILD_A, now: () => NOW.getTime() });

    expect(result.overdue.map((row) => row.id)).toEqual(['a1']);
  });

  test('a guild-A tick marks only guild-A giveaways dirty', async () => {
    const store = new MemoryGiveawayStore();
    await store.create(giveaway('a1', GUILD_A));
    await store.create(giveaway('b1', GUILD_B));

    const dirty = new MemoryDirtyCounts(() => NOW.getTime());
    await reconcile({ store, guildId: GUILD_A, dirty, now: () => NOW.getTime() });

    expect(await dirty.pending(GUILD_A, 10)).toEqual(['a1']);
    expect(await dirty.pending(GUILD_B, 10)).toEqual([]);
  });

  test('the dirty set is per guild, so two guilds cannot flush each other', async () => {
    const dirty = new MemoryDirtyCounts(() => NOW.getTime());

    await dirty.mark(GUILD_A, 'a1');
    await dirty.mark(GUILD_B, 'b1');

    expect(await dirty.pending(GUILD_A, 10)).toEqual(['a1']);

    await dirty.clear(GUILD_A, 'a1');

    expect(await dirty.pending(GUILD_A, 10)).toEqual([]);
    expect(await dirty.pending(GUILD_B, 10)).toEqual(['b1']);
  });

  test('expired claims are scoped to the guild that asked', async () => {
    const store = new MemoryGiveawayStore();
    await store.create(giveaway('a1', GUILD_A));
    await store.create(giveaway('b1', GUILD_B));

    const deadline = new Date(NOW.getTime() - 1_000);

    for (const [id, guild] of [
      ['a1', GUILD_A],
      ['b1', GUILD_B],
    ] as const) {
      await store.beginDraw(guild, id, NOW);
      await store.recordDraw({
        id: `${id}:1`,
        giveawayId: id,
        drawNumber: 1,
        seed: 'a'.repeat(32),
        snapshotHash: 'b'.repeat(64),
        entrantCount: 1,
        totalEntries: 1,
        winnerIds: ['500000000000000000'],
        degradedProviders: [],
        drawnBy: 'test',
        claimDeadline: deadline,
      });
    }

    const expired = await store.expiredClaims(GUILD_A, NOW, 50);

    expect(expired.map((row) => row.giveawayId)).toEqual(['a1']);
  });
});

describe('claim expiry', () => {
  // Bucketing by giveaway rather than by draw forfeited the second draw's winners against the
  // first draw's id, matched nothing, and lost the prize with no error anywhere.
  test('two unclaimed draws of one giveaway are both forfeited', async () => {
    const store = new MemoryGiveawayStore();
    await store.create(giveaway('g1', GUILD_A));

    const deadline = new Date(NOW.getTime() - 1_000);
    const winners = ['500000000000000001', '500000000000000002'];

    for (const [index, winner] of winners.entries()) {
      await store.beginDraw(GUILD_A, 'g1', NOW);
      await store.recordDraw({
        id: `g1:${index + 1}`,
        giveawayId: 'g1',
        drawNumber: index + 1,
        seed: 'a'.repeat(32),
        snapshotHash: 'b'.repeat(64),
        entrantCount: 2,
        totalEntries: 2,
        winnerIds: [winner],
        degradedProviders: [],
        drawnBy: 'test',
        claimDeadline: deadline,
      });
      await store.finishDraw(GUILD_A, 'g1', ['drawing'], 'ended', NOW);
    }

    const expired = await store.expiredClaims(GUILD_A, NOW, 50);
    expect(expired).toHaveLength(2);

    const byDraw = new Map<string, string[]>();
    for (const win of expired) {
      byDraw.set(win.drawId, [...(byDraw.get(win.drawId) ?? []), win.userId]);
    }

    expect(byDraw.size).toBe(2);

    let forfeited = 0;
    for (const [drawId, userIds] of byDraw) {
      forfeited += await store.forfeit(drawId, userIds, NOW);
    }

    expect(forfeited).toBe(2);
  });
});
