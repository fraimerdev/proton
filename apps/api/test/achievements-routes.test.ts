import { describe, expect, test } from 'bun:test';
import type { AchievementRetryOutcome, EventBus, ProtonEvent, TierId } from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import {
  type AchievementsConfigInput,
  achievementsConfigSchema,
  BADGE_ASSET_ID,
} from '@proton/module-achievements/config';
import type {
  AchievementRuntimeState,
  BadgeAsset,
  GuildRuntime,
  Interval,
  JobPatch,
  JobState,
  MemberAchievementState,
  MemberDetailRows,
  MemberFacts,
  Page,
  ResetAchievementInput,
  ResetMemberInput,
  RewardRow,
  RewardStatusCount,
  TierHolders,
  UnlockRow,
} from '@proton/module-achievements/store';
import {
  achievementsOverviewSchema,
  BADGE_UPLOAD_MAX_BYTES,
  badgeUploadResultSchema,
  memberDetailSchema,
  type RewardListQuery,
  rewardListResultSchema,
  type UnlockListQuery,
  unlockListResultSchema,
} from '@proton/module-achievements/view';
import { xpForLevel } from '@proton/module-leveling/curve';
import {
  ACHIEVEMENT_RETRY_WAIT_MS,
  type AchievementRetryMailbox,
  AchievementsService,
  type AchievementsStore,
  badgeAssetId,
} from '../src/achievements/service.ts';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import type { AuditWrite } from '../src/leveling/xp-events.ts';
import { ModuleConfigError, type ModuleConfigView } from '../src/modules/service.ts';
import { type FakeQuery, fakePostgres, pick } from './fake-postgres.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const ADMIN = '100000000000000001';
const SECOND_ADMIN = '100000000000000002';
const MEMBER = '200000000000000001';
const SECOND = '200000000000000002';
const ROLE = '300000000000000001';
const REQUEST = 'req-0000000001';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

const BASE = `/guilds/${GUILD}/achievements`;
const MAILBOX_ID = `${GUILD}:${REQUEST}`;

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const GONE = {
  presence: () => Promise.resolve({ present: [], known: true }),
};

const ZERO: Record<TierId, number> = { single: 0, bronze: 0, silver: 0, gold: 0, diamond: 0 };

const CONFIG: AchievementsConfigInput = {
  enabled: true,
  achievements: [
    {
      id: 'chatter',
      name: 'Chatter',
      kind: 'tiered',
      status: 'active',
      requirements: [{ id: 'msgs', version: 2, trigger: 'messages.sent' }],
      tiers: [
        { id: 'bronze', targets: { msgs: 10 } },
        { id: 'silver', targets: { msgs: 100 } },
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

const LIVE_CONFIG: AchievementsConfigInput = {
  enabled: true,
  achievements: [
    ...(CONFIG.achievements ?? []).filter(({ id }) => id === 'chatter'),
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
    {
      id: 'collector',
      name: 'Collector',
      kind: 'single',
      status: 'active',
      requirements: [{ id: 'earned', trigger: 'achievements.earned' }],
      tiers: [{ id: 'single', targets: { earned: 3 } }],
    },
    {
      id: 'veteran',
      name: 'Veteran',
      kind: 'single',
      status: 'active',
      requirements: [
        {
          id: 'holds',
          trigger: 'achievements.unlocked',
          achievementId: 'chatter',
          tierId: 'bronze',
        },
      ],
      tiers: [{ id: 'single', targets: { holds: 1 } }],
    },
  ],
};

const SCHEDULED_CONFIG: AchievementsConfigInput = {
  enabled: true,
  achievements: [
    {
      id: 'later',
      name: 'Later',
      kind: 'single',
      status: 'active',
      startsAt: new Date(NOW + 7 * DAY).toISOString(),
      requirements: [{ id: 'lvl', trigger: 'leveling.level' }],
      tiers: [{ id: 'single', targets: { lvl: 5 } }],
    },
  ],
};

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

  const header = new DataView(bytes.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);

  return bytes;
}

const PNG = png(16, 16);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);

function unlock(overrides: Partial<UnlockRow> = {}): UnlockRow {
  return {
    guildId: GUILD,
    userId: MEMBER,
    achievementId: 'chatter',
    tierId: 'bronze',
    generation: 0,
    tierIndex: 0,
    unlockedAt: NOW - HOUR,
    revision: 'rev-1',
    definition: {
      name: 'Chatter',
      kind: 'tiered',
      requirements: [
        {
          id: 'msgs',
          version: 2,
          trigger: 'messages.sent',
          target: 10,
          channelIds: [],
          excludedChannelIds: [],
        },
      ],
      rewards: [{ kind: 'add_role', roleId: ROLE }],
      revision: 'rev-1',
    },
    progress: { msgs: 10 },
    cause: { metric: 'messages', occurredAt: NOW - HOUR, sourceModule: 'achievements', depth: 0 },
    originChannelId: null,
    announceGroup: 'group-1',
    announceStatus: 'sent',
    announceAttempts: 1,
    announceLeaseUntil: null,
    announceError: null,
    announcedAt: NOW - HOUR,
    announceMessageId: null,
    publishedAt: NOW - HOUR,
    voidedAt: null,
    voidedBy: null,
    ...overrides,
  };
}

function reward(overrides: Partial<RewardRow> = {}): RewardRow {
  return {
    guildId: GUILD,
    userId: MEMBER,
    achievementId: 'chatter',
    tierId: 'bronze',
    generation: 0,
    rewardKey: `add_role:${ROLE}`,
    rewardEpoch: 0,
    kind: 'add_role',
    roleId: ROLE,
    amount: null,
    status: 'delivered',
    attempts: 1,
    leaseUntil: null,
    nextAttemptAt: null,
    transient: false,
    errorCode: null,
    error: null,
    requestedAt: null,
    deliveredAt: NOW - HOUR,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

type StateSeed = MemberAchievementState & { guildId: string };

function state(overrides: Partial<StateSeed> & Pick<StateSeed, 'achievementId'>): StateSeed {
  return {
    guildId: GUILD,
    userId: MEMBER,
    generation: 0,
    rewardEpoch: 0,
    countedFrom: null,
    values: {},
    unlocked: [],
    almostNotified: [],
    almostNotifiedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<JobState> & Pick<JobState, 'achievementId'>): JobState {
  return {
    job: 'rebuild',
    status: 'running',
    cursor: null,
    requestedAt: NOW - MINUTE,
    requestedBy: ADMIN,
    finishedAt: null,
    result: null,
    announce: false,
    acceptLoss: false,
    ...overrides,
  };
}

class MemoryAchievementStore implements AchievementsStore {
  unlocks: UnlockRow[] = [];
  rewards: RewardRow[] = [];
  states: StateSeed[] = [];
  facts = new Map<string, MemberFacts>();
  modulePeriods = new Map<string, Interval[]>();
  firstActive = new Map<string, number>();
  progressing: Array<{ guildId: string; achievementId: string; members: number }> = [];
  jobRows = new Map<string, JobState>();
  badges = new Map<string, BadgeAsset>();
  pruned: Array<{ guildId: string; keep: string[]; olderThan: number }> = [];
  memberResets: ResetMemberInput[] = [];
  achievementResets: ResetAchievementInput[] = [];
  jobPatches: Array<{ guildId: string; achievementId: string; patch: JobPatch }> = [];
  readonly #audits: NewAuditTrailEntry[];
  readonly #order: string[];

  constructor(audits: NewAuditTrailEntry[], order: string[]) {
    this.#audits = audits;
    this.#order = order;
  }

  #fresh(entry: NewAuditTrailEntry): boolean {
    if (this.#audits.some((held) => held.id === entry.id)) return false;
    this.#audits.push(entry);
    return true;
  }

  async runtime(guildId: string): Promise<GuildRuntime> {
    const runtimeState = new Map<string, AchievementRuntimeState>();
    for (const [key, firstActiveAt] of this.firstActive) {
      const [owner, achievementId] = key.split('/');
      if (owner !== guildId || !achievementId) continue;
      runtimeState.set(achievementId, {
        generation: 0,
        rewardEpoch: 0,
        countedFrom: null,
        firstActiveAt,
        rebuiltWith: null,
      });
    }

    return {
      modulePeriods: this.modulePeriods.get(guildId) ?? [],
      periods: new Map(),
      state: runtimeState,
    };
  }

  async holders(guildId: string): Promise<TierHolders[]> {
    const groups = new Map<string, TierHolders & { users: Set<string> }>();
    for (const row of this.unlocks) {
      if (row.guildId !== guildId || row.voidedAt !== null) continue;

      const key = `${row.achievementId}/${row.tierId}`;
      const group = groups.get(key) ?? {
        achievementId: row.achievementId,
        tierId: row.tierId,
        members: 0,
        users: new Set<string>(),
      };
      group.users.add(row.userId);
      group.members = group.users.size;
      groups.set(key, group);
    }

    return [...groups.values()].map(({ users: _users, ...row }) => row);
  }

  async inProgress(guildId: string) {
    return this.progressing
      .filter((row) => row.guildId === guildId)
      .map(({ achievementId, members }) => ({ achievementId, members }));
  }

  async rewardCounts(guildId: string): Promise<RewardStatusCount[]> {
    const counts = new Map<string, RewardStatusCount>();
    for (const row of this.rewards) {
      if (row.guildId !== guildId) continue;
      const key = `${row.achievementId}/${row.status}`;
      const held = counts.get(key) ?? {
        achievementId: row.achievementId,
        status: row.status,
        count: 0,
      };
      held.count += 1;
      counts.set(key, held);
    }
    return [...counts.values()];
  }

  async jobs(guildId: string): Promise<JobState[]> {
    return [...this.jobRows]
      .filter(([key, row]) => key.startsWith(`${guildId}/`) && row.job !== null)
      .map(([, row]) => row);
  }

  async job(guildId: string, achievementId: string): Promise<JobState | null> {
    return this.jobRows.get(`${guildId}/${achievementId}`) ?? null;
  }

  async setJob(guildId: string, achievementId: string, patch: JobPatch): Promise<void> {
    this.#order.push('setJob');
    this.jobPatches.push({ guildId, achievementId, patch });

    const key = `${guildId}/${achievementId}`;
    const held = this.jobRows.get(key) ?? job({ achievementId, job: null, status: null });
    this.jobRows.set(key, {
      ...held,
      ...(patch.job !== undefined ? { job: patch.job } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
      ...(patch.requestedAt !== undefined ? { requestedAt: patch.requestedAt } : {}),
      ...(patch.requestedBy !== undefined ? { requestedBy: patch.requestedBy } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.announce !== undefined ? { announce: patch.announce } : {}),
      ...(patch.acceptLoss !== undefined ? { acceptLoss: patch.acceptLoss } : {}),
    });
  }

  async listUnlocks(guildId: string, query: UnlockListQuery): Promise<Page<UnlockRow>> {
    const rows = this.unlocks
      .filter(
        (row) =>
          row.guildId === guildId &&
          row.voidedAt === null &&
          (query.achievementId === undefined || row.achievementId === query.achievementId),
      )
      .sort((a, b) => b.unlockedAt - a.unlockedAt);
    const from = (query.page - 1) * query.pageSize;

    return { items: rows.slice(from, from + query.pageSize), total: rows.length };
  }

  async listRewards(guildId: string, query: RewardListQuery): Promise<Page<RewardRow>> {
    const statuses =
      query.status === 'failed'
        ? ['failed']
        : query.status === 'pending'
          ? ['pending', 'delivering', 'requested']
          : null;
    const rows = this.rewards.filter(
      (row) =>
        row.guildId === guildId &&
        (statuses === null || statuses.includes(row.status)) &&
        (query.achievementId === undefined || row.achievementId === query.achievementId),
    );
    const from = (query.page - 1) * query.pageSize;

    return { items: rows.slice(from, from + query.pageSize), total: rows.length };
  }

  async memberDetail(guildId: string, userId: string): Promise<MemberDetailRows> {
    const mine = this.unlocks.filter((row) => row.guildId === guildId && row.userId === userId);

    return {
      states: this.states
        .filter((row) => row.guildId === guildId && row.userId === userId)
        .map(({ guildId: _guildId, ...row }) => row),
      unlocks: mine.filter((row) => row.voidedAt === null),
      voided: mine.filter((row) => row.voidedAt !== null),
      rewards: this.rewards.filter((row) => row.guildId === guildId && row.userId === userId),
      facts: this.facts.get(`${guildId}/${userId}`) ?? null,
    };
  }

  async unlocksOf(guildId: string, userId: string): Promise<UnlockRow[]> {
    return this.unlocks.filter(
      (row) => row.guildId === guildId && row.userId === userId && row.voidedAt === null,
    );
  }

  async resetMember(input: ResetMemberInput): Promise<{ achievements: number }> {
    this.#order.push('resetMember');
    this.memberResets.push(input);
    if (!this.#fresh(input.audit)) return { achievements: 0 };
    return { achievements: input.achievementIds.length };
  }

  async resetAchievement(input: ResetAchievementInput): Promise<{ members: number }> {
    this.#order.push('resetAchievement');
    this.achievementResets.push(input);
    if (!this.#fresh(input.audit)) return { members: 0 };

    return {
      members: new Set(
        this.unlocks
          .filter(
            (row) => row.guildId === input.guildId && row.achievementId === input.achievementId,
          )
          .map((row) => row.userId),
      ).size,
    };
  }

  async putBadge(guildId: string, asset: BadgeAsset): Promise<void> {
    this.#order.push('putBadge');
    this.badges.set(`${guildId}/${asset.assetId}`, asset);
  }

  async pruneBadges(guildId: string, keep: readonly string[], olderThan: number): Promise<number> {
    this.#order.push('pruneBadges');
    this.pruned.push({ guildId, keep: [...keep], olderThan });

    let removed = 0;
    for (const [key, asset] of this.badges) {
      if (!key.startsWith(`${guildId}/`)) continue;
      if (keep.includes(asset.assetId) || asset.uploadedAt >= olderThan) continue;
      this.badges.delete(key);
      removed++;
    }

    return removed;
  }

  async badge(guildId: string, assetId: string) {
    const asset = this.badges.get(`${guildId}/${assetId}`);
    return asset ? { contentType: asset.contentType, base64: asset.base64 } : null;
  }
}

interface HarnessOptions {
  moduleEnabled?: boolean;
  config?: AchievementsConfigInput;
  configError?: Error;
  kept?: Record<string, AchievementRetryOutcome>;
  answer?: AchievementRetryOutcome | null;
  bus?: false;
  mailbox?: false;
  failPublish?: boolean;
  guilds?: unknown;
  resetRows?: (query: FakeQuery) => unknown[][];
  badgeUsage?: [number, number];
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const audits: NewAuditTrailEntry[] = [];
  const events: ProtonEvent[] = [];
  const waits: Array<[string, number]> = [];
  const logs: string[] = [];

  const rows = options.resetRows ?? ((): unknown[][] => []);
  const { handle, queries } = fakePostgres((query) =>
    query.sql.includes('achievement_badges') ? [options.badgeUsage ?? [0, 0]] : rows(query),
  );
  const store = new MemoryAchievementStore(audits, order);
  const config = achievementsConfigSchema.parse(options.config ?? CONFIG);

  const modules = {
    get: async (_guildId: string, moduleId: string): Promise<ModuleConfigView> => {
      order.push('modules');
      if (options.configError) throw options.configError;
      return {
        moduleId,
        enabled: options.moduleEnabled ?? true,
        config,
        schemaVersion: 1,
        migrated: false,
        tier: 'free',
        postables: [],
        simulations: [],
      };
    },
  };

  const audit: AuditWrite = async (entry) => {
    order.push('audit');
    if (audits.some((held) => held.id === entry.id)) return;
    audits.push(JSON.parse(JSON.stringify(entry)));
  };

  const bus: EventBus = {
    publish: async (event) => {
      order.push('publish');
      if (options.failPublish) throw new Error('READONLY You cannot write against a replica.');
      events.push(JSON.parse(JSON.stringify(event)));
    },
    subscribe: () => {
      throw new Error('the api never subscribes');
    },
  };

  const kept = options.kept ?? {};

  const mailbox: AchievementRetryMailbox = {
    recall: async (id) => {
      order.push('recall');
      return kept[id] ?? null;
    },
    wait: async (id, timeoutMs) => {
      order.push('wait');
      waits.push([id, timeoutMs]);
      return options.answer === undefined ? RETRIED : options.answer;
    },
  };

  const achievements = new AchievementsService({
    db: handle,
    store,
    modules,
    audit,
    ...(options.bus === false ? {} : { bus }),
    ...(options.mailbox === false ? {} : { mailbox }),
    logger: { error: (line: string) => logs.push(line) },
    now: () => NOW,
  });

  const app = createApiApp({
    guilds: options.guilds ?? HERE,
    achievements,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  return { app, store, order, audits, events, waits, logs, queries };
}

const NO_SECRET = Symbol('no secret');

function send(
  app: ReturnType<typeof createApiApp>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    bytes?: Uint8Array;
    actor?: string;
    secret?: string | typeof NO_SECRET;
  } = {},
) {
  const secret = options.secret ?? SECRET;

  return app.request(path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': options.bytes ? 'application/octet-stream' : 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
      ...(options.actor === undefined ? {} : { 'x-proton-actor': options.actor }),
    },
    ...(options.bytes
      ? { body: options.bytes }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  });
}

function post(app: ReturnType<typeof createApiApp>, path: string, body: unknown) {
  return send(app, path, { method: 'POST', body });
}

function upload(app: ReturnType<typeof createApiApp>, bytes: Uint8Array, actor?: string) {
  return send(app, `${BASE}/badges`, {
    method: 'PUT',
    bytes,
    ...(actor === undefined ? {} : { actor }),
  });
}

interface Refusal {
  error: string;
  message: string;
}

async function refusal(response: Response): Promise<Refusal> {
  return (await response.json()) as Refusal;
}

const REF = {
  userId: MEMBER,
  achievementId: 'chatter',
  tierId: 'bronze' as const,
  generation: 0,
  rewardKey: `add_role:${ROLE}`,
};

const RETRIED: AchievementRetryOutcome = {
  results: [{ ...REF, status: 'delivered', message: 'Gave the role.' }],
};

const RETRY = {
  requestId: REQUEST,
  rewards: [REF],
  actorId: ADMIN,
  source: 'dashboard',
  ipHash: 'hash123',
};

const JOB = {
  requestId: REQUEST,
  achievementId: 'chatter',
  job: 'rebuild_preview',
  actorId: ADMIN,
  source: 'dashboard',
};

const iso = (at: number) => new Date(at).toISOString();

describe('the shared secret', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', `${BASE}/overview`],
    ['GET', `${BASE}/members/${MEMBER}`],
    ['GET', `${BASE}/unlocks`],
    ['GET', `${BASE}/rewards`],
    ['POST', `${BASE}/rewards/retry`, RETRY],
    ['POST', `${BASE}/resets`, { scope: 'member_all', requestId: REQUEST, userId: MEMBER }],
    ['POST', `${BASE}/jobs`, JOB],
    ['PUT', `${BASE}/badges`],
    ['GET', `${BASE}/badges/abcdefgh`],
  ];

  for (const [method, path, body] of routes) {
    test(`is required for ${method} ${path.slice(BASE.length)}`, async () => {
      const h = harness();

      const response = await send(h.app, path, {
        method,
        body,
        actor: ADMIN,
        secret: NO_SECRET,
      });

      expect(response.status).toBe(401);
      expect(h.order).toEqual([]);
    });
  }
});

describe('GET /guilds/:guildId/achievements/overview', () => {
  function seeded() {
    const h = harness();
    h.store.modulePeriods.set(GUILD, [
      { start: NOW - 3 * DAY, end: null },
      { start: NOW - 10 * DAY, end: NOW - 5 * DAY },
    ]);
    h.store.modulePeriods.set(OTHER, [{ start: NOW - 100 * DAY, end: null }]);
    h.store.firstActive.set(`${GUILD}/chatter`, NOW - 3 * DAY);
    h.store.firstActive.set(`${OTHER}/voice-fan`, NOW - 90 * DAY);
    h.store.unlocks.push(
      unlock(),
      unlock({ userId: SECOND }),
      unlock({ tierId: 'silver', tierIndex: 1 }),
      unlock({ achievementId: 'voice-fan', tierId: 'single', voidedAt: NOW, voidedBy: ADMIN }),
      unlock({ guildId: OTHER, tierId: 'gold', tierIndex: 2 }),
    );
    h.store.progressing.push(
      { guildId: GUILD, achievementId: 'chatter', members: 5 },
      { guildId: OTHER, achievementId: 'chatter', members: 50 },
    );
    h.store.rewards.push(
      reward({ status: 'pending' }),
      reward({ status: 'delivering', userId: SECOND }),
      reward({ status: 'requested', rewardKey: 'xp', kind: 'xp', roleId: null, amount: 50 }),
      reward({ status: 'failed', tierId: 'silver', error: 'Proton needs Manage Roles.' }),
      reward({ status: 'failed', userId: SECOND, tierId: 'silver' }),
      reward({ status: 'delivered', tierId: 'gold' }),
      reward({ guildId: OTHER, status: 'failed' }),
    );
    h.store.jobRows.set(
      `${GUILD}/chatter`,
      job({
        achievementId: 'chatter',
        job: 'rebuild_preview',
        status: 'done',
        requestedAt: NOW - HOUR,
        finishedAt: NOW - HOUR + MINUTE,
        result: { members: 12, changed: 3, lost: 0, newlyEarned: { ...ZERO, bronze: 2 } },
      }),
    );
    h.store.jobRows.set(`${OTHER}/voice-fan`, job({ achievementId: 'voice-fan' }));
    return h;
  }

  test('combines the config, periods, holders, progress, rewards and jobs for this server only', async () => {
    const h = seeded();

    const response = await send(h.app, `${BASE}/overview`);
    expect(response.status).toBe(200);

    const body = achievementsOverviewSchema.parse(await response.json());
    expect(body).toEqual({
      recordingSince: NOW - 10 * DAY,
      periods: {
        module: [
          { start: NOW - 3 * DAY, end: null },
          { start: NOW - 10 * DAY, end: NOW - 5 * DAY },
        ],
      },
      achievements: [
        {
          id: 'chatter',
          firstActiveAt: NOW - 3 * DAY,
          startsAt: null,
          holders: { ...ZERO, bronze: 2, silver: 1, gold: 0 },
          inProgress: 5,
          rewards: { pending: 3, failed: 2 },
          job: {
            kind: 'rebuild_preview',
            status: 'done',
            requestedAt: NOW - HOUR,
            finishedAt: NOW - HOUR + MINUTE,
            result: { members: 12, changed: 3, lost: 0, newlyEarned: { ...ZERO, bronze: 2 } },
          },
        },
        {
          id: 'voice-fan',
          firstActiveAt: null,
          startsAt: null,
          holders: ZERO,
          inProgress: 0,
          rewards: { pending: 0, failed: 0 },
          job: null,
        },
      ],
    });
  });

  test('says recording has not started while the module has never been on', async () => {
    const h = harness();

    const body = achievementsOverviewSchema.parse(
      await (await send(h.app, `${BASE}/overview`)).json(),
    );

    expect(body.recordingSince).toBeNull();
    expect(body.periods.module).toEqual([]);
  });

  test('is not behind the write-presence guard, so a server Proton left can still be read', async () => {
    const h = harness({ guilds: GONE });

    expect((await send(h.app, `${BASE}/overview`)).status).toBe(200);
  });

  test('passes a settings read failure on with its sentence', async () => {
    const h = harness({
      configError: new ModuleConfigError(
        'invalid_stored_config',
        'Proton could not read this server’s Achievements settings: achievements.0.kind is wrong',
      ),
    });

    const response = await send(h.app, `${BASE}/overview`);

    expect(response.status).toBe(400);
    expect(await refusal(response)).toEqual({
      error: 'invalid_stored_config',
      message:
        'Proton could not read this server’s Achievements settings: achievements.0.kind is wrong',
    });
  });
});

describe('GET /guilds/:guildId/achievements/members/:userId', () => {
  function seeded(resetRows?: (query: FakeQuery) => unknown[][]) {
    const h = harness(resetRows ? { resetRows } : {});
    h.store.states.push(
      state({
        achievementId: 'chatter',
        generation: 1,
        values: {
          msgs: { value: 42, version: 2, generation: 1 },
          dropped: { value: 7, version: 1, generation: 1 },
        },
        unlocked: ['bronze'],
      }),
      state({
        achievementId: 'voice-fan',
        generation: 1,
        values: { mins: { value: 30, version: 1, generation: 0 } },
      }),
      state({
        achievementId: 'old-badge',
        values: { posts: { value: 3, version: 4, generation: 0 } },
        unlocked: ['single'],
      }),
      state({ achievementId: 'forgotten', values: { x: { value: 9, version: 1, generation: 0 } } }),
      state({
        guildId: OTHER,
        achievementId: 'chatter',
        values: { msgs: { value: 999, version: 2, generation: 0 } },
      }),
    );
    h.store.unlocks.push(
      unlock({ generation: 1, announceLeaseUntil: NOW + MINUTE }),
      unlock({ voidedAt: NOW - DAY, voidedBy: ADMIN, unlockedAt: NOW - 2 * DAY }),
      unlock({
        achievementId: 'old-badge',
        tierId: 'single',
        definition: {
          name: 'Old badge',
          kind: 'single',
          requirements: [
            {
              id: 'posts',
              version: 4,
              trigger: 'messages.sent',
              target: 3,
              channelIds: [],
              excludedChannelIds: [],
            },
          ],
          rewards: [],
          revision: 'rev-9',
        },
      }),
      unlock({ guildId: OTHER, achievementId: 'elsewhere' }),
    );
    h.store.rewards.push(
      reward({
        generation: 1,
        status: 'failed',
        error: 'Proton needs Manage Roles to give this role.',
        errorCode: 'missing_permission',
        leaseUntil: NOW + MINUTE,
      }),
      reward({ guildId: OTHER, achievementId: 'elsewhere' }),
    );
    h.store.facts.set(`${GUILD}/${MEMBER}`, {
      userId: MEMBER,
      joinedAt: NOW - 400 * DAY,
      premiumSince: null,
      leftAt: null,
      updatedAt: NOW - DAY,
    });
    h.store.facts.set(`${OTHER}/${MEMBER}`, {
      userId: MEMBER,
      joinedAt: NOW - 5 * DAY,
      premiumSince: NOW - DAY,
      leftAt: null,
      updatedAt: NOW,
    });
    return h;
  }

  test('computes each value from the current requirement versions, falling back to the snapshot', async () => {
    const h = seeded();

    const response = await send(h.app, `${BASE}/members/${MEMBER}`);
    expect(response.status).toBe(200);

    const body = memberDetailSchema.parse(await response.json());
    expect(body.userId).toBe(MEMBER);
    expect(body.facts).toEqual({
      joinedAt: NOW - 400 * DAY,
      premiumSince: null,
      leftAt: null,
      updatedAt: NOW - DAY,
    });
    expect(
      Object.fromEntries(body.achievements.map((entry) => [entry.achievementId, entry.values])),
    ).toEqual({
      chatter: { msgs: 42 },
      'voice-fan': { mins: 0 },
      'old-badge': { posts: 3 },
      forgotten: {},
    });
    expect(body.achievements[0]).toMatchObject({
      generation: 1,
      unlocked: ['bronze'],
      resetAt: null,
      resetBy: null,
    });
  });

  test('keeps voided unlocks apart and leaves storage fields and other servers out', async () => {
    const h = seeded();

    const raw = await (await send(h.app, `${BASE}/members/${MEMBER}`)).json();
    const body = memberDetailSchema.parse(raw);

    expect(body.unlocks.map((row) => row.achievementId)).toEqual(['chatter', 'old-badge']);
    expect(body.voided.map((row) => [row.achievementId, row.voidedBy])).toEqual([
      ['chatter', ADMIN],
    ]);
    expect(body.rewards).toHaveLength(1);
    expect(body.rewards[0]).toMatchObject({
      status: 'failed',
      error: 'Proton needs Manage Roles to give this role.',
    });

    expect(body.achievements.flatMap((entry) => Object.values(entry.values))).not.toContain(999);

    const text = JSON.stringify(raw);
    expect(text).not.toContain('guildId');
    expect(text).not.toContain('leaseUntil');
    expect(text).not.toContain('LeaseUntil');
    expect(text).not.toContain('elsewhere');
  });

  test('names the most recent reset, whether it was the member’s or the whole server’s', async () => {
    const h = seeded((query) => {
      if (query.params[0] !== GUILD) return [];

      if (query.sql.includes('from "achievement_members"')) {
        return [
          pick(query, { achievement_id: 'chatter', reset_at: iso(NOW - DAY), reset_by: ADMIN }),
        ];
      }

      if (query.sql.includes('from "achievement_state"')) {
        return [
          pick(query, {
            achievement_id: 'chatter',
            reset_at: iso(NOW - 2 * DAY),
            reset_by: SECOND_ADMIN,
          }),
          pick(query, {
            achievement_id: 'voice-fan',
            reset_at: iso(NOW - HOUR),
            reset_by: SECOND_ADMIN,
          }),
        ];
      }

      return [];
    });

    const body = memberDetailSchema.parse(
      await (await send(h.app, `${BASE}/members/${MEMBER}`)).json(),
    );
    const resets = Object.fromEntries(
      body.achievements.map((entry) => [entry.achievementId, [entry.resetAt, entry.resetBy]]),
    );

    expect(resets.chatter).toEqual([NOW - DAY, ADMIN]);
    expect(resets['voice-fan']).toEqual([NOW - HOUR, SECOND_ADMIN]);
    expect(resets['old-badge']).toEqual([null, null]);
    expect(h.queries.every((query) => query.params[0] === GUILD)).toBe(true);
    expect(h.queries.find((query) => query.sql.includes('achievement_members'))?.params).toEqual(
      expect.arrayContaining([GUILD, MEMBER]),
    );
  });

  test('reads level, membership, prerequisites and the earned count live, not from storage', async () => {
    const h = harness({
      config: LIVE_CONFIG,
      resetRows: (query) =>
        query.sql.includes('from "members"') ? [pick(query, { xp: xpForLevel(25) })] : [],
    });
    h.store.states.push(
      state({
        achievementId: 'chatter',
        values: { msgs: { value: 42, version: 2, generation: 0 } },
      }),
      state({ achievementId: 'rising-star' }),
      state({
        achievementId: 'anniversary',
        values: { days: { value: 40, version: 1, generation: 0 } },
      }),
      state({ achievementId: 'collector' }),
      state({ achievementId: 'veteran' }),
    );
    h.store.unlocks.push(
      unlock({ achievementId: 'chatter', tierId: 'bronze' }),
      unlock({ achievementId: 'old-badge', tierId: 'single' }),
      unlock({ achievementId: 'collector', tierId: 'single' }),
    );
    h.store.facts.set(`${GUILD}/${MEMBER}`, {
      userId: MEMBER,
      joinedAt: NOW - 400 * DAY,
      premiumSince: null,
      leftAt: null,
      updatedAt: NOW - 200 * DAY,
    });

    const body = memberDetailSchema.parse(
      await (await send(h.app, `${BASE}/members/${MEMBER}`)).json(),
    );

    expect(
      Object.fromEntries(body.achievements.map((entry) => [entry.achievementId, entry.values])),
    ).toEqual({
      chatter: { msgs: 42 },
      'rising-star': { lvl: 25 },
      anniversary: { days: 400 },
      collector: { earned: 2 },
      veteran: { holds: 1 },
    });
    expect(h.queries.filter((query) => query.sql.includes('from "members"'))).toHaveLength(1);
  });

  test('a member who left, and one no prerequisite covers, count for nothing', async () => {
    const h = harness({ config: LIVE_CONFIG });
    h.store.states.push(
      state({
        achievementId: 'anniversary',
        values: { days: { value: 900, version: 1, generation: 0 } },
      }),
      state({ achievementId: 'veteran' }),
    );
    h.store.facts.set(`${GUILD}/${MEMBER}`, {
      userId: MEMBER,
      joinedAt: NOW - 900 * DAY,
      premiumSince: null,
      leftAt: NOW - DAY,
      updatedAt: NOW - DAY,
    });

    const body = memberDetailSchema.parse(
      await (await send(h.app, `${BASE}/members/${MEMBER}`)).json(),
    );

    expect(
      Object.fromEntries(body.achievements.map((entry) => [entry.achievementId, entry.values])),
    ).toEqual({ anniversary: { days: 0 }, veteran: { holds: 0 } });
  });

  test('asks the leveling table nothing when no shown requirement is a level', async () => {
    const h = seeded();

    await send(h.app, `${BASE}/members/${MEMBER}`);

    expect(h.queries.some((query) => query.sql.includes('from "members"'))).toBe(false);
  });

  test('refuses a user id that is not a Discord snowflake', async () => {
    const h = seeded();

    const response = await send(h.app, `${BASE}/members/not-a-user`);

    expect(response.status).toBe(400);
    expect(await refusal(response)).toEqual({
      error: 'invalid_request',
      message: 'not-a-user isn’t a Discord user ID.',
    });
  });

  test('answers an empty record for a member with nothing stored', async () => {
    const h = harness();

    const body = memberDetailSchema.parse(
      await (await send(h.app, `${BASE}/members/${SECOND}`)).json(),
    );

    expect(body).toEqual({
      userId: SECOND,
      facts: null,
      achievements: [],
      unlocks: [],
      voided: [],
      rewards: [],
    });
  });
});

describe('GET /guilds/:guildId/achievements/unlocks', () => {
  function seeded() {
    const h = harness();
    h.store.unlocks.push(
      unlock({ unlockedAt: NOW - 3 * HOUR }),
      unlock({ userId: SECOND, unlockedAt: NOW - 2 * HOUR }),
      unlock({ achievementId: 'voice-fan', tierId: 'single', unlockedAt: NOW - HOUR }),
      unlock({ userId: SECOND, voidedAt: NOW, voidedBy: ADMIN }),
      unlock({ guildId: OTHER, unlockedAt: NOW }),
      unlock({ guildId: OTHER, achievementId: 'voice-fan', tierId: 'single' }),
    );
    return h;
  }

  test('pages this server’s unlocks, newest first, reading numbers from the query string', async () => {
    const h = seeded();

    const response = await send(h.app, `${BASE}/unlocks?page=1&pageSize=2`);
    expect(response.status).toBe(200);

    const body = unlockListResultSchema.parse(await response.json());
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(2);
    expect(body.items.map((row) => row.unlockedAt)).toEqual([NOW - HOUR, NOW - 2 * HOUR]);
    expect(JSON.stringify(body)).not.toContain(OTHER);
  });

  test('filters by achievement and treats a blank filter as none', async () => {
    const h = seeded();

    const filtered = unlockListResultSchema.parse(
      await (await send(h.app, `${BASE}/unlocks?achievementId=voice-fan`)).json(),
    );
    const blank = unlockListResultSchema.parse(
      await (await send(h.app, `${BASE}/unlocks?achievementId=`)).json(),
    );

    expect(filtered.items.map((row) => row.achievementId)).toEqual(['voice-fan']);
    expect(blank.total).toBe(3);
  });

  test('refuses a page size over the limit or an id that is not an achievement id', async () => {
    const h = seeded();

    const big = await send(h.app, `${BASE}/unlocks?pageSize=500`);
    const bad = await send(h.app, `${BASE}/unlocks?achievementId=NOT%20AN%20ID`);

    expect([big.status, bad.status]).toEqual([400, 400]);
    expect((await refusal(big)).error).toBe('invalid_query');
    expect((await refusal(bad)).message).toStartWith('achievementId:');
  });
});

describe('GET /guilds/:guildId/achievements/rewards', () => {
  function seeded() {
    const h = harness();
    h.store.rewards.push(
      reward({ status: 'failed' }),
      reward({ status: 'pending', userId: SECOND }),
      reward({ status: 'requested', rewardKey: 'xp', kind: 'xp', roleId: null, amount: 50 }),
      reward({ status: 'delivered', tierId: 'silver' }),
      reward({ guildId: OTHER, status: 'failed' }),
    );
    return h;
  }

  test('lists failed rewards for this server only', async () => {
    const h = seeded();

    const body = rewardListResultSchema.parse(
      await (await send(h.app, `${BASE}/rewards?status=failed`)).json(),
    );

    expect(body.total).toBe(1);
    expect(body.items.map((row) => row.status)).toEqual(['failed']);
    expect(JSON.stringify(body)).not.toContain('leaseUntil');
  });

  test('counts rewards still on their way as pending', async () => {
    const h = seeded();

    const body = rewardListResultSchema.parse(
      await (await send(h.app, `${BASE}/rewards?status=pending`)).json(),
    );

    expect(body.items.map((row) => row.status).sort()).toEqual(['pending', 'requested']);
  });

  test('refuses a status it does not list', async () => {
    const h = seeded();

    const response = await send(h.app, `${BASE}/rewards?status=delivered`);

    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe('invalid_query');
  });
});

describe('POST /guilds/:guildId/achievements/rewards/retry', () => {
  const RETRY_PATH = `${BASE}/rewards/retry`;

  test('recalls, checks the module, audits, publishes, then waits for the worker', async () => {
    const h = harness();

    const response = await post(h.app, RETRY_PATH, RETRY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RETRIED);
    expect(h.order).toEqual(['recall', 'modules', 'audit', 'publish', 'wait']);
    expect(h.waits).toEqual([[MAILBOX_ID, ACHIEVEMENT_RETRY_WAIT_MS]]);
  });

  test('publishes the request under an id taken from the request', async () => {
    const h = harness();

    await post(h.app, RETRY_PATH, RETRY);

    expect(h.events).toEqual([
      {
        id: `achievements.reward_retry_requested:${GUILD}:${REQUEST}`,
        type: 'achievements.reward_retry_requested',
        guildId: GUILD,
        occurredAt: NOW,
        payload: { requestId: REQUEST, guildId: GUILD, actorId: ADMIN, rewards: [REF] },
      },
    ]);
    expect(h.audits).toEqual([
      {
        id: `achievements.reward_retry:${GUILD}:${REQUEST}`,
        guildId: GUILD,
        actorId: ADMIN,
        source: 'dashboard',
        action: 'module.achievements.reward.retry',
        before: null,
        after: { requestId: REQUEST, rewards: [REF] },
        ipHash: 'hash123',
      },
    ]);
  });

  test('a retried press gets the kept answer before anything else is checked', async () => {
    const kept: AchievementRetryOutcome = {
      results: [{ ...REF, status: 'failed', message: 'Proton needs Manage Roles.' }],
    };
    const h = harness({ kept: { [MAILBOX_ID]: kept }, moduleEnabled: false, bus: false });

    const response = await post(h.app, RETRY_PATH, RETRY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(kept);
    expect(h.order).toEqual(['recall']);
  });

  test('refuses while the module is switched off, in its row or in its settings', async () => {
    for (const options of [
      { moduleEnabled: false },
      { config: { ...CONFIG, enabled: false } },
    ] satisfies HarnessOptions[]) {
      const h = harness(options);

      const response = await post(h.app, RETRY_PATH, RETRY);

      expect(response.status).toBe(409);
      expect(await refusal(response)).toEqual({
        error: 'module_disabled',
        message: 'Achievements is off in this server, so nothing was retried. Turn it on first.',
      });
      expect(h.audits).toHaveLength(0);
      expect(h.events).toHaveLength(0);
    }
  });

  test('says the retry ran long when the wait runs out', async () => {
    const h = harness({ answer: null });

    const response = await post(h.app, RETRY_PATH, RETRY);

    expect(response.status).toBe(409);
    const body = await refusal(response);
    expect(body.error).toBe('worker_timeout');
    expect(body.message).toStartWith('The retry took longer than 20 seconds.');
  });

  test('answers 503 without a bus or a mailbox, saying nothing was retried', async () => {
    const noBus = harness({ bus: false });
    const noMailbox = harness({ mailbox: false });

    const [a, b] = await Promise.all([
      post(noBus.app, RETRY_PATH, RETRY),
      post(noMailbox.app, RETRY_PATH, RETRY),
    ]);

    expect([a.status, b.status]).toEqual([503, 503]);
    expect((await refusal(a)).message).toContain('so nothing was retried');
    expect((await refusal(b)).message).toContain('so nothing was retried');
    expect(noBus.audits).toHaveLength(0);
  });

  test('a publish that fails is reported as not passed on, and logged', async () => {
    const h = harness({ failPublish: true });

    const response = await post(h.app, RETRY_PATH, RETRY);

    expect(response.status).toBe(503);
    expect((await refusal(response)).message).toBe(
      'Proton hit a problem, so nothing was retried. Try again in a moment.',
    );
    expect(h.logs).toHaveLength(1);
    expect(h.order).not.toContain('wait');
  });

  test('refuses a body without an actor, a request id or any reward', async () => {
    const h = harness();
    const { actorId: _actor, ...noActor } = RETRY;

    const responses = await Promise.all([
      post(h.app, RETRY_PATH, noActor),
      post(h.app, RETRY_PATH, { ...RETRY, requestId: 'short' }),
      post(h.app, RETRY_PATH, { ...RETRY, rewards: [] }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(await responses[0]?.json()).toMatchObject({ error: 'invalid_body' });
    expect(h.order).toEqual([]);
  });

  test('is caught by the write-presence guard, saying nothing was done', async () => {
    const h = harness({ guilds: GONE });

    const response = await post(h.app, RETRY_PATH, RETRY);

    expect(response.status).toBe(409);
    expect(await refusal(response)).toEqual({
      error: 'bot_absent',
      message:
        'Discord says Proton is not in this server, so nothing was done. Invite Proton back to ' +
        'the server and try again.',
    });
    expect(h.order).toEqual([]);
  });
});

describe('POST /guilds/:guildId/achievements/resets', () => {
  const RESETS = `${BASE}/resets`;

  test('resets one achievement for one member with the audit row in the same call', async () => {
    const h = harness();

    const response = await post(h.app, RESETS, {
      scope: 'member_achievement',
      requestId: REQUEST,
      userId: MEMBER,
      achievementId: 'chatter',
      actorId: ADMIN,
      source: 'dashboard',
      ipHash: 'hash123',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ achievements: 1, members: 1 });
    expect(h.store.memberResets).toEqual([
      {
        guildId: GUILD,
        achievementIds: ['chatter'],
        userId: MEMBER,
        allowRewardsAgain: false,
        actorId: ADMIN,
        at: NOW,
        audit: {
          id: `achievements.reset:${GUILD}:${REQUEST}`,
          guildId: GUILD,
          actorId: ADMIN,
          source: 'dashboard',
          action: 'module.achievements.reset',
          before: null,
          after: {
            scope: 'member_achievement',
            requestId: REQUEST,
            userId: MEMBER,
            achievementIds: ['chatter'],
            allowRewardsAgain: false,
          },
          ipHash: 'hash123',
        },
      },
    ]);
  });

  test('a member-wide reset covers every configured achievement and every one they hold', async () => {
    const h = harness();
    h.store.unlocks.push(
      unlock({ achievementId: 'retired', tierId: 'single' }),
      unlock({ guildId: OTHER, achievementId: 'elsewhere', tierId: 'single' }),
    );

    const response = await post(h.app, RESETS, {
      scope: 'member_all',
      requestId: REQUEST,
      userId: MEMBER,
      allowRewardsAgain: true,
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ achievements: 3, members: 1 });
    expect(h.store.memberResets[0]?.achievementIds).toEqual(['chatter', 'voice-fan', 'retired']);
    expect(h.store.memberResets[0]?.allowRewardsAgain).toBe(true);
  });

  test('a retired achievement the member still holds can be reset on its own', async () => {
    const h = harness();
    h.store.unlocks.push(unlock({ achievementId: 'retired', tierId: 'single' }));

    const response = await post(h.app, RESETS, {
      scope: 'member_achievement',
      requestId: REQUEST,
      userId: MEMBER,
      achievementId: 'retired',
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(response.status).toBe(200);
    expect(h.store.memberResets[0]?.achievementIds).toEqual(['retired']);
  });

  test('refuses an achievement that is neither configured nor held, resetting nothing', async () => {
    const h = harness();
    h.store.unlocks.push(unlock({ guildId: OTHER, achievementId: 'elsewhere', tierId: 'single' }));

    const response = await post(h.app, RESETS, {
      scope: 'member_achievement',
      requestId: REQUEST,
      userId: MEMBER,
      achievementId: 'elsewhere',
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(response.status).toBe(404);
    expect(await refusal(response)).toEqual({
      error: 'not_found',
      message:
        'This server’s Achievements settings have no achievement with the ID elsewhere, so ' +
        'nothing was reset.',
    });
    expect(h.store.memberResets).toHaveLength(0);
  });

  test('a server-wide reset needs the achievement’s name typed exactly', async () => {
    const h = harness();

    const wrong = await post(h.app, RESETS, {
      scope: 'achievement',
      requestId: REQUEST,
      achievementId: 'chatter',
      confirmation: 'chatter',
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(wrong.status).toBe(400);
    expect(await refusal(wrong)).toEqual({
      error: 'invalid_request',
      message:
        'The name typed doesn’t match Chatter, so nothing was reset. Type the achievement’s ' +
        'name exactly to reset it for everyone.',
    });
    expect(h.store.achievementResets).toHaveLength(0);
  });

  test('a server-wide reset with the name typed resets everyone and says how many', async () => {
    const h = harness();
    h.store.unlocks.push(unlock(), unlock({ userId: SECOND }), unlock({ guildId: OTHER }));

    const response = await post(h.app, RESETS, {
      scope: 'achievement',
      requestId: REQUEST,
      achievementId: 'chatter',
      confirmation: '  Chatter ',
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ achievements: 1, members: 2 });
    expect(h.store.achievementResets).toHaveLength(1);
    expect(h.store.achievementResets[0]).toMatchObject({
      guildId: GUILD,
      achievementId: 'chatter',
      allowRewardsAgain: false,
      actorId: ADMIN,
      at: NOW,
      audit: {
        id: `achievements.reset:${GUILD}:${REQUEST}`,
        action: 'module.achievements.reset',
        after: { scope: 'achievement', achievementIds: ['chatter'] },
      },
    });
  });

  test('a server-wide reset refuses an achievement that is not configured', async () => {
    const h = harness();

    const response = await post(h.app, RESETS, {
      scope: 'achievement',
      requestId: REQUEST,
      achievementId: 'retired',
      confirmation: 'Retired',
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(response.status).toBe(404);
    expect(h.store.achievementResets).toHaveLength(0);
  });

  test('a replayed request resets nothing the second time', async () => {
    const h = harness();
    const body = {
      scope: 'member_achievement',
      requestId: REQUEST,
      userId: MEMBER,
      achievementId: 'chatter',
      actorId: ADMIN,
      source: 'dashboard',
    };

    await post(h.app, RESETS, body);
    const replay = await post(h.app, RESETS, body);

    expect(await replay.json()).toEqual({ achievements: 0, members: 0 });
    expect(h.audits).toHaveLength(1);
  });

  test('refuses a body with an unknown scope or without the confirmation', async () => {
    const h = harness();

    const responses = await Promise.all([
      post(h.app, RESETS, { scope: 'everything', requestId: REQUEST, actorId: ADMIN }),
      post(h.app, RESETS, {
        scope: 'achievement',
        requestId: REQUEST,
        achievementId: 'chatter',
        actorId: ADMIN,
        source: 'dashboard',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400]);
    expect(h.order).toEqual([]);
  });

  test('is scoped to the guild in the path', async () => {
    const h = harness();

    await post(h.app, `/guilds/${OTHER}/achievements/resets`, {
      scope: 'member_achievement',
      requestId: REQUEST,
      userId: MEMBER,
      achievementId: 'chatter',
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(h.store.memberResets.map((input) => [input.guildId, input.audit.guildId])).toEqual([
      [OTHER, OTHER],
    ]);
  });
});

describe('POST /guilds/:guildId/achievements/jobs', () => {
  const JOBS = `${BASE}/jobs`;

  test('queues the job, audits it, then publishes it', async () => {
    const h = harness();

    const response = await post(h.app, JOBS, { ...JOB, ipHash: 'hash123' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'queued' });
    expect(h.order).toEqual(['modules', 'setJob', 'audit', 'publish']);
    expect(h.store.jobPatches).toEqual([
      {
        guildId: GUILD,
        achievementId: 'chatter',
        patch: {
          job: 'rebuild_preview',
          status: 'queued',
          cursor: null,
          requestedAt: NOW,
          requestedBy: ADMIN,
          finishedAt: null,
          result: null,
          announce: false,
          acceptLoss: false,
        },
      },
    ]);
    expect(h.audits).toEqual([
      {
        id: `achievements.job:${GUILD}:${REQUEST}`,
        guildId: GUILD,
        actorId: ADMIN,
        source: 'dashboard',
        action: 'module.achievements.job.rebuild_preview',
        before: null,
        after: {
          requestId: REQUEST,
          achievementId: 'chatter',
          job: 'rebuild_preview',
          announce: false,
          acceptLoss: false,
        },
        ipHash: 'hash123',
      },
    ]);
    expect(h.events).toEqual([
      {
        id: `achievements.job_requested:${GUILD}:${REQUEST}`,
        type: 'achievements.job_requested',
        guildId: GUILD,
        occurredAt: NOW,
        payload: {
          requestId: REQUEST,
          guildId: GUILD,
          actorId: ADMIN,
          achievementId: 'chatter',
          job: 'rebuild_preview',
          announce: false,
          acceptLoss: false,
        },
      },
    ]);
  });

  test('refuses while a job for that achievement is queued or running', async () => {
    for (const status of ['queued', 'running'] as const) {
      const h = harness();
      h.store.jobRows.set(`${GUILD}/chatter`, job({ achievementId: 'chatter', status }));

      const response = await post(h.app, JOBS, JOB);

      expect(response.status).toBe(409);
      expect(await refusal(response)).toEqual({
        error: 'job_running',
        message: `A rebuild of Chatter is already ${status}, so another wasn’t started. Wait for it to finish, then try again.`,
      });
      expect(h.events).toHaveLength(0);
      expect(h.store.jobPatches).toHaveLength(0);
    }
  });

  test('starts again once the last job finished, or after one was left running for hours', async () => {
    for (const held of [
      job({ achievementId: 'chatter', status: 'done', finishedAt: NOW - MINUTE }),
      job({ achievementId: 'chatter', status: 'failed' }),
      job({ achievementId: 'chatter', status: 'running', requestedAt: NOW - 7 * HOUR }),
    ]) {
      const h = harness();
      h.store.jobRows.set(`${GUILD}/chatter`, held);

      expect((await post(h.app, JOBS, JOB)).status).toBe(200);
      expect(h.events).toHaveLength(1);
    }
  });

  test('a queued re-check sleeping until a future start date does not block a new job', async () => {
    const h = harness({ config: SCHEDULED_CONFIG });
    h.store.jobRows.set(
      `${GUILD}/later`,
      job({ achievementId: 'later', job: 'recheck', status: 'queued' }),
    );

    const response = await post(h.app, JOBS, { ...JOB, achievementId: 'later', job: 'recheck' });

    expect(response.status).toBe(200);
    expect(h.events).toHaveLength(1);
  });

  test('a re-check already running on a scheduled achievement still blocks a new job', async () => {
    const h = harness({ config: SCHEDULED_CONFIG });
    h.store.jobRows.set(
      `${GUILD}/later`,
      job({ achievementId: 'later', job: 'recheck', status: 'running' }),
    );

    const response = await post(h.app, JOBS, { ...JOB, achievementId: 'later', job: 'recheck' });

    expect(response.status).toBe(409);
    expect(h.events).toHaveLength(0);
  });

  test('a job running for another achievement or another server does not block this one', async () => {
    const h = harness();
    h.store.jobRows.set(`${GUILD}/voice-fan`, job({ achievementId: 'voice-fan' }));
    h.store.jobRows.set(`${OTHER}/chatter`, job({ achievementId: 'chatter' }));

    expect((await post(h.app, JOBS, JOB)).status).toBe(200);
  });

  test('refuses while the module is off, and for an achievement not in the settings', async () => {
    const off = harness({ moduleEnabled: false });
    const unknown = harness();

    const [a, b] = await Promise.all([
      post(off.app, JOBS, JOB),
      post(unknown.app, JOBS, { ...JOB, achievementId: 'retired' }),
    ]);

    expect([a.status, b.status]).toEqual([409, 404]);
    expect((await refusal(a)).message).toBe(
      'Achievements is off in this server, so nothing was started. Turn it on first.',
    );
    expect((await refusal(b)).error).toBe('not_found');
    expect([...off.store.jobPatches, ...unknown.store.jobPatches]).toHaveLength(0);
  });

  test('answers 503 without a bus, saying nothing was started', async () => {
    const h = harness({ bus: false });

    const response = await post(h.app, JOBS, JOB);

    expect(response.status).toBe(503);
    expect((await refusal(response)).message).toContain('so nothing was started');
    expect(h.store.jobPatches).toHaveLength(0);
  });

  test('a publish that fails marks the job failed so the next request is not refused', async () => {
    const h = harness({ failPublish: true });

    const response = await post(h.app, JOBS, JOB);

    expect(response.status).toBe(503);
    expect(h.store.jobRows.get(`${GUILD}/chatter`)).toMatchObject({
      status: 'failed',
      finishedAt: NOW,
      result: { reason: expect.stringContaining('never started') },
    });
    expect(h.logs).toHaveLength(1);
  });

  test('refuses a body naming a job that does not exist', async () => {
    const h = harness();

    const response = await post(h.app, JOBS, { ...JOB, job: 'rebuild_everything' });

    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe('invalid_body');
  });
});

describe('PUT /guilds/:guildId/achievements/badges', () => {
  test('stores a PNG under an id taken from its content, and audits the upload', async () => {
    const h = harness();

    const response = await upload(h.app, PNG, ADMIN);

    expect(response.status).toBe(200);
    const body = badgeUploadResultSchema.parse(await response.json());
    expect(body).toEqual({
      assetId: badgeAssetId(PNG),
      contentType: 'image/png',
      byteSize: PNG.byteLength,
    });
    expect(body.assetId).toMatch(BADGE_ASSET_ID);
    expect(h.store.badges.get(`${GUILD}/${body.assetId}`)).toEqual({
      assetId: body.assetId,
      contentType: 'image/png',
      base64: Buffer.from(PNG).toString('base64'),
      byteSize: PNG.byteLength,
      uploadedBy: ADMIN,
      uploadedAt: NOW,
    });
    expect(h.audits).toEqual([
      {
        id: `achievements.badge:${GUILD}:${body.assetId}`,
        guildId: GUILD,
        actorId: ADMIN,
        source: 'dashboard',
        action: 'module.achievements.badge.upload',
        before: null,
        after: { assetId: body.assetId, contentType: 'image/png', byteSize: PNG.byteLength },
        ipHash: null,
      },
    ]);
  });

  test('sniffs the type from the bytes and gives the same bytes the same id', async () => {
    const h = harness();

    const gif = (await (await upload(h.app, GIF, ADMIN)).json()) as { contentType: string };
    const first = (await (await upload(h.app, PNG, ADMIN)).json()) as { assetId: string };
    const again = (await (await upload(h.app, PNG, SECOND_ADMIN)).json()) as { assetId: string };

    expect(gif.contentType).toBe('image/gif');
    expect(again.assetId).toBe(first.assetId);
    expect(h.audits).toHaveLength(2);
  });

  test('accepts an image of exactly the limit and refuses one byte more', async () => {
    const h = harness();
    const at = new Uint8Array(BADGE_UPLOAD_MAX_BYTES);
    at.set(PNG);
    const over = new Uint8Array(BADGE_UPLOAD_MAX_BYTES + 1);
    over.set(PNG);

    const accepted = await upload(h.app, at, ADMIN);
    const refused = await upload(h.app, over, ADMIN);

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(await refusal(refused)).toEqual({
      error: 'too_large',
      message: 'A badge image may be at most 256 KB, and that one is larger, so it wasn’t saved.',
    });
    expect(h.store.badges.size).toBe(1);
  });

  test('refuses a file that is not a PNG, JPEG or GIF, or is empty', async () => {
    const h = harness();

    const text = await upload(h.app, new TextEncoder().encode('<svg></svg>'), ADMIN);
    const empty = await upload(h.app, new Uint8Array(0), ADMIN);

    expect([text.status, empty.status]).toEqual([400, 400]);
    expect(await refusal(text)).toEqual({
      error: 'unsupported_image',
      message: 'That file isn’t a PNG, JPEG or GIF, so it wasn’t saved.',
    });
    expect((await refusal(empty)).message).toBe('That file is empty, so it wasn’t saved.');
    expect(h.store.badges.size).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  // A 16000×16000 all-zero PNG deflates well under the byte cap, and every render decodes all of it.
  test('refuses a small image that declares huge dimensions, naming the size it is', async () => {
    const h = harness();

    const response = await upload(h.app, png(16_000, 16_000), ADMIN);

    expect(response.status).toBe(400);
    expect(await refusal(response)).toEqual({
      error: 'unsupported_image',
      message:
        'A badge image may be at most 1024×1024 pixels, and that one is 16000×16000, so it ' +
        'wasn’t saved.',
    });
    expect(h.store.badges.size).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  test('refuses an image whose header is too damaged to give a size', async () => {
    const h = harness();

    const response = await upload(
      h.app,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
      ADMIN,
    );

    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe('unsupported_image');
    expect(h.store.badges.size).toBe(0);
  });

  test('accepts an image of exactly the largest side allowed', async () => {
    const h = harness();

    expect((await upload(h.app, png(1_024, 1_024), ADMIN)).status).toBe(200);
    expect((await upload(h.app, png(1_025, 1_024), ADMIN)).status).toBe(400);
    expect(h.store.badges.size).toBe(1);
  });

  test('drops images no achievement uses before storing a new one', async () => {
    const h = harness({
      config: {
        ...CONFIG,
        achievements: (CONFIG.achievements ?? []).map((achievement, index) =>
          index === 0 ? { ...achievement, badge: { assetId: 'kept00001' } } : achievement,
        ),
      },
    });

    const seed = (assetId: string, uploadedAt: number): void => {
      h.store.badges.set(`${GUILD}/${assetId}`, {
        assetId,
        contentType: 'image/png',
        base64: Buffer.from(PNG).toString('base64'),
        byteSize: PNG.byteLength,
        uploadedBy: ADMIN,
        uploadedAt,
      });
    };

    seed('kept00001', NOW - 2 * DAY);
    seed('stale0001', NOW - 2 * DAY);
    seed('fresh0001', NOW - HOUR);

    expect((await upload(h.app, PNG, ADMIN)).status).toBe(200);

    expect(h.store.pruned).toEqual([{ guildId: GUILD, keep: ['kept00001'], olderThan: NOW - DAY }]);
    expect([...h.store.badges.keys()].sort()).toEqual([
      `${GUILD}/${badgeAssetId(PNG)}`,
      `${GUILD}/fresh0001`,
      `${GUILD}/kept00001`,
    ]);
  });

  test('refuses a new image once the server holds as many as Proton keeps', async () => {
    const full = harness({ badgeUsage: [20, 0] });
    const known = harness({ badgeUsage: [20, 1] });

    const refused = await upload(full.app, PNG, ADMIN);
    const again = await upload(known.app, PNG, ADMIN);

    expect(refused.status).toBe(409);
    expect(await refusal(refused)).toEqual({
      error: 'too_many_badges',
      message:
        'This server already has 20 badge images, the most Proton keeps, so that one wasn’t ' +
        'saved. Images no achievement uses are removed a day after upload, so try again later, ' +
        'or use an image an achievement already has.',
    });
    expect(full.store.badges.size).toBe(0);
    expect(full.audits).toHaveLength(0);

    expect(again.status).toBe(200);
    expect(known.store.badges.size).toBe(1);
  });

  test('is refused when no actor is named', async () => {
    const h = harness();

    const response = await upload(h.app, PNG);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(h.store.badges.size).toBe(0);
  });

  test('is caught by the write-presence guard for a server Proton has left', async () => {
    const h = harness({ guilds: GONE });

    expect((await upload(h.app, PNG, ADMIN)).status).toBe(409);
    expect(h.store.badges.size).toBe(0);
  });
});

describe('GET /guilds/:guildId/achievements/badges/:assetId', () => {
  test('streams the stored bytes with their type', async () => {
    const h = harness();
    await upload(h.app, GIF, ADMIN);
    const assetId = badgeAssetId(GIF);

    const response = await send(h.app, `${BASE}/badges/${assetId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(response.headers.get('content-length')).toBe(String(GIF.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GIF);
  });

  test('never serves another server’s badge, and answers 404 for a malformed id', async () => {
    const h = harness();
    await send(h.app, `/guilds/${OTHER}/achievements/badges`, {
      method: 'PUT',
      bytes: PNG,
      actor: ADMIN,
    });

    const elsewhere = await send(h.app, `${BASE}/badges/${badgeAssetId(PNG)}`);
    const malformed = await send(h.app, `${BASE}/badges/NOT-AN-ID`);

    expect([elsewhere.status, malformed.status]).toEqual([404, 404]);
    expect((await refusal(elsewhere)).error).toBe('not_found');
    expect(
      (await send(h.app, `/guilds/${OTHER}/achievements/badges/${badgeAssetId(PNG)}`)).status,
    ).toBe(200);
  });
});
