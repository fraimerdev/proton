import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EventBus, ProtonEvent, TierId } from '@proton/core';
import { createDb, type DbHandle, guildModules, runMigrations } from '@proton/db';
import { guilds, members } from '@proton/db/schema';
import { DrizzleAchievementStore } from '@proton/module-achievements';
import {
  type AchievementsConfig,
  type AchievementsConfigInput,
  achievementsConfigSchema,
  achievementsDefaultConfig,
  MODULE_ID,
} from '@proton/module-achievements/config';
import type { UnlockInput } from '@proton/module-achievements/store';
import {
  achievementsOverviewSchema,
  badgeUploadResultSchema,
  memberDetailSchema,
  unlockListResultSchema,
} from '@proton/module-achievements/view';
import { xpForLevel } from '@proton/module-leveling/curve';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AchievementsService } from '../src/achievements/service.ts';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { auditTrailWriter } from '../src/leveling/xp-events.ts';
import type { ModuleConfigView } from '../src/modules/service.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleAchievementStore;

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const ADMIN = '100000000000000001';
const MEMBER = '200000000000000001';
const SECOND = '200000000000000002';
const THIRD = '200000000000000003';
const ROLE = '300000000000000001';
const CHANNEL = '500000000000000001';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const NOW = T0 + 2 * HOUR;

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const CONFIG: AchievementsConfigInput = {
  enabled: true,
  achievements: [
    {
      id: 'chatter',
      name: 'Chatter',
      kind: 'tiered',
      status: 'active',
      requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
      tiers: [
        { id: 'bronze', targets: { msgs: 2 }, rewards: [{ kind: 'add_role', roleId: ROLE }] },
        { id: 'silver', targets: { msgs: 5 } },
      ],
    },
    {
      id: 'voice-fan',
      name: 'Voice fan',
      kind: 'single',
      status: 'active',
      requirements: [{ id: 'mins', trigger: 'voice.minutes' }],
      tiers: [{ id: 'single', targets: { mins: 60 } }],
    },
  ],
};

// A real IHDR, because the upload refuses an image whose declared size it cannot read.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16,
  0, 0, 0, 16,
]);

const configs = new Map<string, { enabled: boolean; config: AchievementsConfig }>();
const events: ProtonEvent[] = [];

const modules = {
  get: async (guildId: string, moduleId: string): Promise<ModuleConfigView> => {
    const held = configs.get(guildId);
    return {
      moduleId,
      enabled: held?.enabled ?? false,
      config: held?.config ?? achievementsDefaultConfig,
      schemaVersion: 1,
      migrated: false,
      tier: 'free',
      postables: [],
      simulations: [],
    };
  },
};

const bus: EventBus = {
  publish: async (event) => {
    events.push(event);
  },
  subscribe: () => {
    throw new Error('the api never subscribes');
  },
};

function app() {
  const achievements = new AchievementsService({
    db: handle,
    store,
    modules,
    audit: auditTrailWriter(handle),
    bus,
    logger: { error: () => {} },
    now: () => NOW,
  });

  return createApiApp({ guilds: HERE, achievements, sharedSecret: SECRET } as unknown as ApiDeps);
}

function send(
  path: string,
  options: { method?: string; body?: unknown; bytes?: Uint8Array; actor?: string } = {},
) {
  return app().request(path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': options.bytes ? 'application/octet-stream' : 'application/json',
      'x-proton-secret': SECRET,
      ...(options.actor === undefined ? {} : { 'x-proton-actor': options.actor }),
    },
    ...(options.bytes
      ? { body: options.bytes }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  });
}

async function setModule(guildId: string, enabled: boolean, input: AchievementsConfigInput) {
  const config = achievementsConfigSchema.parse(input);
  configs.set(guildId, { enabled, config });

  await handle.db
    .insert(guildModules)
    .values({ guildId, moduleId: MODULE_ID, enabled, config })
    .onConflictDoUpdate({
      target: [guildModules.guildId, guildModules.moduleId],
      set: { enabled, config },
    });
}

function unlockInput(
  guildId: string,
  userId: string,
  achievementId: string,
  tierId: TierId,
  options: { generation?: number; rewards?: boolean } = {},
): UnlockInput {
  return {
    guildId,
    userId,
    achievementId,
    generation: options.generation ?? 0,
    rewardEpoch: 0,
    tiers: [
      {
        tierId,
        tierIndex: tierId === 'silver' ? 1 : 0,
        revision: 'rev-1',
        definition: {
          name: achievementId,
          kind: tierId === 'single' ? 'single' : 'tiered',
          requirements: [
            {
              id: 'msgs',
              version: 1,
              trigger: 'messages.sent',
              target: 2,
              channelIds: [],
              excludedChannelIds: [],
            },
          ],
          rewards: options.rewards === false ? [] : [{ kind: 'add_role', roleId: ROLE }],
          revision: 'rev-1',
        },
        progress: { msgs: 2 },
      },
    ],
    unlockedAt: T0 + HOUR,
    cause: { metric: 'messages', occurredAt: T0 + HOUR, sourceModule: 'discord', depth: 0 },
    originChannelId: CHANNEL,
    announceGroup: `${userId}:${achievementId}:${tierId}`,
    announce: 'pending',
  };
}

async function message(guildId: string, userId: string, n: number) {
  await store.record(
    {
      guildId,
      userId,
      metric: 'messages',
      sourceKey: `${guildId}:${userId}:${n}`,
      occurredAt: T0 + n * MINUTE,
      spanStart: null,
      amount: 1,
      channelId: CHANNEL,
      parentId: null,
      categoryId: null,
      temporary: false,
      xpSource: null,
      groupKey: null,
      pending: false,
      sourceModule: 'discord',
      causation: { kind: 'organic', rootId: `message.created:${n}`, depth: 0 },
    },
    [{ achievementId: 'chatter', requirementId: 'msgs', version: 1, aggregate: 'sum', amount: 1 }],
    ['chatter'],
  );
}

async function auditRows(guildId: string) {
  const rows = await handle.client<{ id: string; action: string; actor_id: string }[]>`
    select id, action, actor_id from audit_trail where guild_id = ${guildId} order by id`;
  return [...rows];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleAchievementStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  configs.clear();
  events.length = 0;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER, name: 'other guild' },
  ]);

  for (const guildId of [GUILD, OTHER]) {
    await setModule(guildId, true, CONFIG);
    await store.syncPeriods(guildId, T0);
  }
});

describe('overview', () => {
  test('counts holders, progress and outstanding rewards from the tables, for this server only', async () => {
    await store.unlock(unlockInput(GUILD, MEMBER, 'chatter', 'bronze'));
    await store.unlock(unlockInput(GUILD, SECOND, 'chatter', 'bronze'));
    await store.unlock(unlockInput(GUILD, MEMBER, 'chatter', 'silver', { rewards: false }));
    await message(GUILD, MEMBER, 1);
    await message(GUILD, THIRD, 2);

    await store.unlock(unlockInput(OTHER, MEMBER, 'chatter', 'bronze'));
    await store.unlock(unlockInput(OTHER, SECOND, 'voice-fan', 'single'));
    await message(OTHER, SECOND, 3);

    const response = await send(`/guilds/${GUILD}/achievements/overview`);
    expect(response.status).toBe(200);

    const body = achievementsOverviewSchema.parse(await response.json());
    expect(body.recordingSince).toBe(T0);
    expect(body.periods.module).toEqual([{ start: T0, end: null }]);
    expect(body.achievements).toEqual([
      {
        id: 'chatter',
        firstActiveAt: T0,
        startsAt: null,
        holders: { single: 0, bronze: 2, silver: 1, gold: 0, diamond: 0 },
        inProgress: 2,
        rewards: { pending: 2, failed: 0 },
        job: null,
      },
      {
        id: 'voice-fan',
        firstActiveAt: T0,
        startsAt: null,
        holders: { single: 0, bronze: 0, silver: 0, gold: 0, diamond: 0 },
        inProgress: 0,
        rewards: { pending: 0, failed: 0 },
        job: null,
      },
    ]);
  });

  test('pages unlocks newest first without another server’s', async () => {
    await store.unlock(unlockInput(GUILD, MEMBER, 'chatter', 'bronze'));
    await store.unlock(unlockInput(GUILD, SECOND, 'chatter', 'bronze'));
    await store.unlock(unlockInput(OTHER, THIRD, 'chatter', 'bronze'));

    const body = unlockListResultSchema.parse(
      await (await send(`/guilds/${GUILD}/achievements/unlocks?pageSize=1`)).json(),
    );

    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect([MEMBER, SECOND]).toContain(body.items[0]?.userId ?? '');
  });
});

describe('member', () => {
  const DAY = 24 * HOUR;

  const LIVE: AchievementsConfigInput = {
    enabled: true,
    achievements: [
      {
        id: 'rising-star',
        name: 'Rising star',
        kind: 'single',
        status: 'active',
        requirements: [{ id: 'lvl', trigger: 'leveling.level' }],
        tiers: [{ id: 'single', targets: { lvl: 25 } }],
      },
      {
        id: 'anniversary',
        name: 'Anniversary',
        kind: 'single',
        status: 'active',
        requirements: [{ id: 'days', trigger: 'membership.days' }],
        tiers: [{ id: 'single', targets: { days: 365 } }],
      },
    ],
  };

  test('reads the level from xp and the days from the facts row, not the stored copies', async () => {
    await setModule(GUILD, true, LIVE);
    await store.upsertFacts(GUILD, MEMBER, { joinedAt: NOW - 400 * DAY, leftAt: null });
    await handle.db
      .insert(members)
      .values({ guildId: GUILD, userId: MEMBER, xp: xpForLevel(25), level: 0 });
    await store.setValues(GUILD, MEMBER, [
      { achievementId: 'rising-star', requirementId: 'lvl', version: 1, value: 3 },
      { achievementId: 'anniversary', requirementId: 'days', version: 1, value: 40 },
    ]);

    const response = await send(`/guilds/${GUILD}/achievements/members/${MEMBER}`);
    expect(response.status).toBe(200);

    const body = memberDetailSchema.parse(await response.json());
    expect(
      Object.fromEntries(body.achievements.map((entry) => [entry.achievementId, entry.values])),
    ).toEqual({ 'rising-star': { lvl: 25 }, anniversary: { days: 400 } });
  });
});

describe('resets', () => {
  test('a member reset voids their unlock, cancels the pending reward and is audited once', async () => {
    await store.unlock(unlockInput(GUILD, MEMBER, 'chatter', 'bronze'));
    await store.unlock(unlockInput(OTHER, MEMBER, 'chatter', 'bronze'));

    const body = {
      scope: 'member_achievement',
      requestId: 'reset-00000001',
      userId: MEMBER,
      achievementId: 'chatter',
      actorId: ADMIN,
      source: 'dashboard',
    };

    const response = await send(`/guilds/${GUILD}/achievements/resets`, {
      method: 'POST',
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ achievements: 1, members: 1 });

    const replay = await send(`/guilds/${GUILD}/achievements/resets`, { method: 'POST', body });
    expect(await replay.json()).toEqual({ achievements: 0, members: 0 });

    const [member] = await handle.client<{ generation: number; reset_by: string | null }[]>`
      select generation, reset_by from achievement_members
       where guild_id = ${GUILD} and user_id = ${MEMBER} and achievement_id = 'chatter'`;
    expect(member).toEqual({ generation: 1, reset_by: ADMIN });

    const rewards = await handle.client<{ guild_id: string; status: string }[]>`
      select guild_id, status from achievement_rewards where user_id = ${MEMBER} order by guild_id`;
    expect([...rewards]).toEqual([
      { guild_id: GUILD, status: 'cancelled' },
      { guild_id: OTHER, status: 'pending' },
    ]);

    expect(await auditRows(GUILD)).toEqual([
      {
        id: `achievements.reset:${GUILD}:reset-00000001`,
        action: 'module.achievements.reset',
        actor_id: ADMIN,
      },
    ]);

    const detail = memberDetailSchema.parse(
      await (await send(`/guilds/${GUILD}/achievements/members/${MEMBER}`)).json(),
    );
    expect(detail.unlocks).toEqual([]);
    expect(detail.voided.map((row) => [row.achievementId, row.voidedBy])).toEqual([
      ['chatter', ADMIN],
    ]);
    expect(detail.achievements).toEqual([
      expect.objectContaining({
        achievementId: 'chatter',
        generation: 1,
        resetAt: NOW,
        resetBy: ADMIN,
        values: { msgs: 0 },
        unlocked: [],
      }),
    ]);

    const elsewhere = memberDetailSchema.parse(
      await (await send(`/guilds/${OTHER}/achievements/members/${MEMBER}`)).json(),
    );
    expect(elsewhere.unlocks).toHaveLength(1);
    expect(elsewhere.achievements[0]?.resetAt).toBeNull();
  });

  test('a member-wide reset also covers an achievement no longer in the settings', async () => {
    await store.unlock(unlockInput(GUILD, MEMBER, 'retired', 'single', { rewards: false }));

    const response = await send(`/guilds/${GUILD}/achievements/resets`, {
      method: 'POST',
      body: {
        scope: 'member_all',
        requestId: 'reset-00000002',
        userId: MEMBER,
        actorId: ADMIN,
        source: 'dashboard',
      },
    });

    expect(await response.json()).toEqual({ achievements: 3, members: 1 });

    const ids = await handle.client<{ achievement_id: string }[]>`
      select achievement_id from achievement_members
       where guild_id = ${GUILD} and user_id = ${MEMBER} and generation = 1
       order by achievement_id`;
    expect(ids.map((row) => row.achievement_id)).toEqual(['chatter', 'retired', 'voice-fan']);
  });

  test('a server-wide reset needs the name and bumps the achievement’s generation', async () => {
    await store.unlock(unlockInput(GUILD, MEMBER, 'chatter', 'bronze'));
    await store.unlock(unlockInput(GUILD, SECOND, 'chatter', 'bronze'));

    const refused = await send(`/guilds/${GUILD}/achievements/resets`, {
      method: 'POST',
      body: {
        scope: 'achievement',
        requestId: 'reset-00000003',
        achievementId: 'chatter',
        confirmation: 'Chat',
        actorId: ADMIN,
        source: 'dashboard',
      },
    });
    expect(refused.status).toBe(400);

    const response = await send(`/guilds/${GUILD}/achievements/resets`, {
      method: 'POST',
      body: {
        scope: 'achievement',
        requestId: 'reset-00000004',
        achievementId: 'chatter',
        confirmation: 'Chatter',
        allowRewardsAgain: true,
        actorId: ADMIN,
        source: 'dashboard',
      },
    });
    expect(await response.json()).toEqual({ achievements: 1, members: 2 });

    const [state] = await handle.client<{ generation: number; reward_epoch: number }[]>`
      select generation, reward_epoch from achievement_state
       where guild_id = ${GUILD} and achievement_id = 'chatter'`;
    expect(state).toEqual({ generation: 1, reward_epoch: 1 });

    const [voided] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from achievement_unlocks
       where guild_id = ${GUILD} and voided_at is not null`;
    expect(voided?.n).toBe(2);
    expect((await auditRows(GUILD)).map((row) => row.id)).toEqual([
      `achievements.reset:${GUILD}:reset-00000004`,
    ]);
  });
});

describe('jobs', () => {
  const JOB = {
    achievementId: 'chatter',
    job: 'rebuild',
    announce: true,
    acceptLoss: false,
    actorId: ADMIN,
    source: 'dashboard',
  };

  test('queues the job in the state row, publishes it, and refuses a second while it waits', async () => {
    const first = await send(`/guilds/${GUILD}/achievements/jobs`, {
      method: 'POST',
      body: { ...JOB, requestId: 'job-000000001' },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'queued' });

    expect(await store.job(GUILD, 'chatter')).toMatchObject({
      job: 'rebuild',
      status: 'queued',
      requestedAt: NOW,
      requestedBy: ADMIN,
      announce: true,
      acceptLoss: false,
    });
    expect(events.map((event) => [event.id, event.type])).toEqual([
      [`achievements.job_requested:${GUILD}:job-000000001`, 'achievements.job_requested'],
    ]);
    expect((await auditRows(GUILD)).map((row) => row.action)).toEqual([
      'module.achievements.job.rebuild',
    ]);

    const second = await send(`/guilds/${GUILD}/achievements/jobs`, {
      method: 'POST',
      body: { ...JOB, requestId: 'job-000000002' },
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('job_running');

    const elsewhere = await send(`/guilds/${OTHER}/achievements/jobs`, {
      method: 'POST',
      body: { ...JOB, requestId: 'job-000000003' },
    });
    expect(elsewhere.status).toBe(200);
  });

  test('shows in the overview and can be asked for again once it is done', async () => {
    await send(`/guilds/${GUILD}/achievements/jobs`, {
      method: 'POST',
      body: { ...JOB, requestId: 'job-000000004' },
    });
    await store.setJob(GUILD, 'chatter', {
      status: 'done',
      finishedAt: NOW + MINUTE,
      result: {
        members: 3,
        changed: 1,
        lost: 0,
        newlyEarned: { single: 0, bronze: 1, silver: 0, gold: 0, diamond: 0 },
      },
    });

    const overview = achievementsOverviewSchema.parse(
      await (await send(`/guilds/${GUILD}/achievements/overview`)).json(),
    );
    expect(overview.achievements[0]?.job).toEqual({
      kind: 'rebuild',
      status: 'done',
      requestedAt: NOW,
      finishedAt: NOW + MINUTE,
      result: {
        members: 3,
        changed: 1,
        lost: 0,
        newlyEarned: { single: 0, bronze: 1, silver: 0, gold: 0, diamond: 0 },
      },
    });

    const again = await send(`/guilds/${GUILD}/achievements/jobs`, {
      method: 'POST',
      body: { ...JOB, job: 'recheck', requestId: 'job-000000005' },
    });
    expect(again.status).toBe(200);
    expect((await store.job(GUILD, 'chatter'))?.status).toBe('queued');
  });

  test('refuses while the module is off without touching the state row', async () => {
    await setModule(GUILD, false, CONFIG);

    const response = await send(`/guilds/${GUILD}/achievements/jobs`, {
      method: 'POST',
      body: { ...JOB, requestId: 'job-000000006' },
    });

    expect(response.status).toBe(409);
    expect((await store.job(GUILD, 'chatter'))?.job ?? null).toBeNull();
    expect(events).toHaveLength(0);
  });
});

describe('badges', () => {
  test('an upload is stored once per content, audited, and served back only to its server', async () => {
    const first = await send(`/guilds/${GUILD}/achievements/badges`, {
      method: 'PUT',
      bytes: PNG,
      actor: ADMIN,
    });
    expect(first.status).toBe(200);

    const uploaded = badgeUploadResultSchema.parse(await first.json());
    expect(uploaded.contentType).toBe('image/png');
    expect(uploaded.byteSize).toBe(PNG.byteLength);

    await send(`/guilds/${GUILD}/achievements/badges`, { method: 'PUT', bytes: PNG, actor: ADMIN });

    const rows = await handle.client<
      { asset_id: string; content_type: string; byte_size: number; uploaded_by: string }[]
    >`
      select asset_id, content_type, byte_size, uploaded_by from achievement_badges
       where guild_id = ${GUILD}`;
    expect([...rows]).toEqual([
      {
        asset_id: uploaded.assetId,
        content_type: 'image/png',
        byte_size: PNG.byteLength,
        uploaded_by: ADMIN,
      },
    ]);
    expect((await auditRows(GUILD)).map((row) => row.id)).toEqual([
      `achievements.badge:${GUILD}:${uploaded.assetId}`,
    ]);

    const served = await send(`/guilds/${GUILD}/achievements/badges/${uploaded.assetId}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    const elsewhere = await send(`/guilds/${OTHER}/achievements/badges/${uploaded.assetId}`);
    expect(elsewhere.status).toBe(404);
  });

  test('a refused upload stores nothing', async () => {
    const response = await send(`/guilds/${GUILD}/achievements/badges`, {
      method: 'PUT',
      bytes: new TextEncoder().encode('GIF? no'),
      actor: ADMIN,
    });

    expect(response.status).toBe(400);

    const [count] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from achievement_badges where guild_id = ${GUILD}`;
    expect(count?.n).toBe(0);
    expect(await auditRows(GUILD)).toEqual([]);
  });
});
