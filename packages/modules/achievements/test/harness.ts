import {
  type AchievementRetryOutcome,
  type AchievementRewardRef,
  type ActionExecutor,
  type CaseInput,
  type CaseRecorder,
  type Causation,
  type ChannelState,
  type DedupeStore,
  DefaultActionExecutor,
  type EventListener,
  type EventType,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  isScopedActionExecutor,
  type Logger,
  type MemberRolesLookup,
  type ModuleContext,
  newId,
  type Overwrite,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
  type ScheduledHandler,
  type ScheduleOptions,
  type ScheduleOutcome,
  type XpGrantRequested,
  type XpSource,
  xpAwardedSchema,
  xpGrantedSchema,
  xpGrantRequestedSchema,
  xpLevelGainedSchema,
} from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import { dispatch } from '@proton/fixtures';
import { z } from 'zod';
import {
  type AchievementsConfig,
  type AchievementsConfigInput,
  achievementsConfigSchema,
  achievementsDefaultConfig,
  MODULE_ID,
} from '../src/config.ts';
import type {
  AchievementLimits,
  AchievementsDeps,
  FencedLocks,
  MemberLookup,
} from '../src/deps.ts';
import { achievementsModule, createAchievementsModule } from '../src/index.ts';
import {
  type AchievementStore,
  type RewardRow,
  requirementValue,
  type UnlockRow,
} from '../src/store.ts';
import { validateConfig } from '../src/validate.ts';
import type { AchievementVoiceStore } from '../src/voice-store.ts';
import { MemoryAchievementStore } from './memory-store.ts';
import {
  MemoryAchievementVoiceStore,
  MemoryFencedLocks,
  MemoryLimits,
} from './memory-voice-store.ts';

export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const OWNER = '200000000000000001';
export const STAFF = '200000000000000002';
export const PROTON = '300000000000000001';

export const MEMBER = '100000000000000001';
export const OTHER = '100000000000000002';
export const THIRD = '100000000000000003';
export const FOURTH = '100000000000000004';

export const CATEGORY = '500000000000000009';
export const TEXT = '500000000000000001';
export const OTHER_TEXT = '500000000000000002';
export const ANNOUNCE = '500000000000000003';
export const VOICE = '500000000000000004';
export const AFK_VOICE = '500000000000000005';
export const DM_CHANNEL = '500000000000000099';

export const MEMBER_ROLE = '410000000000000001';
export const REWARD_ROLE = '410000000000000002';
export const SECOND_REWARD_ROLE = '410000000000000003';
export const BOT_ROLE = '410000000000000005';
export const HIGH_ROLE = '410000000000000009';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

export const JOINED_AT = '2026-01-01T00:00:00.000000+00:00';

export const XP_PER_LEVEL = 100;

export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.SendMessagesInThreads |
  Permissions.EmbedLinks |
  Permissions.AttachFiles |
  Permissions.ReadMessageHistory |
  Permissions.ManageRoles;

export const MEMBERS = [MEMBER, OTHER, THIRD, FOURTH] as const;

const DRAIN_LIMIT = 2_000;
const JOB_LIMIT = 500;
const DISCORD_EPOCH = 1_420_070_400_000n;
const MEMBER_PATH = /^\/guilds\/(\d+)\/members\/(\d+)$/;
const ROLE_PATH = /^\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/;
const MESSAGE_PATH = /^\/channels\/(\d+)\/messages$/;

const EMITS: readonly string[] = achievementsModule.emits ?? [];
const ACTION_KINDS: readonly string[] = achievementsModule.actionKinds ?? [];
const SCHEDULES: readonly string[] = achievementsModule.schedules ?? [];

let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

export function snowflakeAt(at: number, increment = next() % 4096): string {
  return String(((BigInt(at) - DISCORD_EPOCH) << 22n) + BigInt(increment));
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeMember {
  roles: string[];
  bot: boolean;
  joinedAt: string | null;
  premiumSince: string | null;
}

export interface RestExchange {
  request: RestRequestOptions;
  status: number;
  body: unknown;
}

interface Refusal {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export class FakeRest implements RestProxyClient {
  readonly exchanges: RestExchange[] = [];
  readonly #members = new Map<string, FakeMember>();
  #refusals: Refusal[] = [];
  #messages = 0;

  join(guildId: string, userId: string, member: Partial<FakeMember> = {}): void {
    this.#members.set(`${guildId}:${userId}`, {
      roles: member.roles ?? [MEMBER_ROLE],
      bot: member.bot ?? false,
      joinedAt: member.joinedAt === undefined ? JOINED_AT : member.joinedAt,
      premiumSince: member.premiumSince ?? null,
    });
  }

  leave(guildId: string, userId: string): void {
    this.#members.delete(`${guildId}:${userId}`);
  }

  member(guildId: string, userId: string): FakeMember | null {
    const found = this.#members.get(`${guildId}:${userId}`);
    return found ? { ...found, roles: [...found.roles] } : null;
  }

  fail(method: string, pathPrefix: string, status: number, body?: unknown): void {
    this.#refusals.push({
      method,
      path: pathPrefix,
      status,
      body: body ?? { message: 'refused by the test' },
    });
  }

  heal(): void {
    this.#refusals = [];
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    const response = this.#answer(options);
    this.exchanges.push({ request: options, status: response.status, body: response.body });
    return response;
  }

  #answer(options: RestRequestOptions): RestResponse {
    const { method, path } = options;

    const refusal = this.#refusals.find(
      (entry) => entry.method === method && path.startsWith(entry.path),
    );
    if (refusal) return { status: refusal.status, body: refusal.body };

    const member = MEMBER_PATH.exec(path);
    if (method === 'GET' && member) {
      const [, guildId = '', userId = ''] = member;
      const found = this.#members.get(`${guildId}:${userId}`);
      if (!found) return { status: 404, body: { code: 10007, message: 'Unknown Member' } };
      return {
        status: 200,
        body: {
          user: { id: userId, bot: found.bot },
          roles: [...found.roles],
          joined_at: found.joinedAt,
          premium_since: found.premiumSince,
        },
      };
    }

    const role = ROLE_PATH.exec(path);
    if (role && (method === 'PUT' || method === 'DELETE')) {
      const [, guildId = '', userId = '', roleId = ''] = role;
      const found = this.#members.get(`${guildId}:${userId}`);
      if (!found) return { status: 404, body: { code: 10007, message: 'Unknown Member' } };

      const kept = found.roles.filter((held) => held !== roleId);
      found.roles = method === 'PUT' ? [...kept, roleId] : kept;
      return { status: 204, body: null };
    }

    if (method === 'POST' && path === '/users/@me/channels') {
      return { status: 200, body: { id: DM_CHANNEL, type: 1 } };
    }

    const channel = MESSAGE_PATH.exec(path);
    if (method === 'POST' && channel) {
      this.#messages += 1;
      return {
        status: 200,
        body: {
          id: String(1_500_000_000_000_000_000n + BigInt(this.#messages)),
          channel_id: channel[1],
        },
      };
    }

    return { status: 200, body: {} };
  }
}

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

export class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

export interface BookedJob {
  guildId: string;
  jobId: string;
  runAt: number;
  naturalKey: string;
  data: unknown;
  replace: boolean;
}

export class FakeScheduler {
  readonly booked: BookedJob[] = [];
  #pending: BookedJob[] = [];

  pending(jobId?: string, guildId?: string): BookedJob[] {
    return this.#pending.filter(
      (job) =>
        (jobId === undefined || job.jobId === jobId) &&
        (guildId === undefined || job.guildId === guildId),
    );
  }

  #same(job: BookedJob, other: Pick<BookedJob, 'guildId' | 'jobId' | 'naturalKey'>): boolean {
    return (
      job.guildId === other.guildId &&
      job.jobId === other.jobId &&
      job.naturalKey === other.naturalKey
    );
  }

  schedule(
    guildId: string,
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data: unknown,
    options?: ScheduleOptions,
  ): ScheduleOutcome {
    const job: BookedJob = {
      guildId,
      jobId,
      runAt: runAt.getTime(),
      naturalKey,
      data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)),
      replace: options?.replace === true,
    };
    this.booked.push(job);

    const held = this.#pending.some((pending) => this.#same(pending, job));
    if (held && !job.replace) return { scheduled: false, replaced: false };

    this.#pending = [...this.#pending.filter((pending) => !this.#same(pending, job)), job];
    return { scheduled: true, replaced: held };
  }

  cancel(guildId: string, jobId: string, naturalKey: string): void {
    this.#pending = this.#pending.filter(
      (pending) => !this.#same(pending, { guildId, jobId, naturalKey }),
    );
  }

  due(now: number): BookedJob | undefined {
    return [...this.#pending]
      .filter((job) => job.runAt <= now)
      .sort((a, b) => a.runAt - b.runAt)[0];
  }

  take(job: BookedJob): void {
    this.#pending = this.#pending.filter((pending) => pending !== job);
  }

  restore(job: BookedJob): void {
    if (!this.#pending.some((pending) => this.#same(pending, job))) this.#pending.push(job);
  }
}

type Publish = (guildId: string, type: EventType, naturalKey: string, payload: unknown) => void;

interface Credit {
  source: XpSource;
  channelId: string | undefined;
  causation: Causation;
  key: string;
}

export class FakeLeveling {
  readonly requests: XpGrantRequested[] = [];
  readonly #xp = new Map<string, number>();
  readonly #granted = new Map<string, number>();
  readonly #publish: Publish;
  readonly #clock: { now: number };
  #gains = 0;

  constructor(publish: Publish, clock: { now: number }) {
    this.#publish = publish;
    this.#clock = clock;
  }

  xpOf(guildId: string, userId: string): number {
    return this.#xp.get(`${guildId}:${userId}`) ?? 0;
  }

  levelOf(guildId: string, userId: string): number {
    return Math.floor(this.xpOf(guildId, userId) / XP_PER_LEVEL);
  }

  grantsFor(userId: string): string[] {
    return [...this.#granted.keys()].filter((grantId) => grantId.split(':')[2] === userId);
  }

  gain(guildId: string, userId: string, amount: number, channelId?: string): void {
    this.#gains += 1;
    this.#credit(guildId, userId, amount, {
      source: 'message',
      channelId,
      causation: { kind: 'organic', rootId: `leveling:gain:${this.#gains}`, depth: 0 },
      key: `gain:${this.#gains}`,
    });
  }

  answer(event: ProtonEvent): void {
    const request = xpGrantRequestedSchema.parse(event.payload);
    this.requests.push(request);

    if (!this.#granted.has(request.grantId)) {
      this.#granted.set(request.grantId, request.amount);
      this.#credit(request.guildId, request.userId, request.amount, {
        source: 'reward',
        channelId: request.originChannelId,
        causation: {
          kind: 'reward',
          rootId: request.causation.rootId,
          depth: request.causation.depth,
          grantId: request.grantId,
          sourceModule: request.sourceModule,
        },
        key: `grant:${request.grantId}`,
      });
    }

    this.#publish(
      request.guildId,
      'xp.granted',
      request.grantId,
      xpGrantedSchema.parse({
        guildId: request.guildId,
        userId: request.userId,
        grantId: request.grantId,
        sourceModule: request.sourceModule,
        status: 'granted',
        amount: request.amount,
        xp: this.xpOf(request.guildId, request.userId),
        level: this.levelOf(request.guildId, request.userId),
      }),
    );
  }

  #credit(guildId: string, userId: string, amount: number, credit: Credit): void {
    const previousLevel = this.levelOf(guildId, userId);
    const xp = this.xpOf(guildId, userId) + amount;
    this.#xp.set(`${guildId}:${userId}`, xp);
    const level = this.levelOf(guildId, userId);
    const channel = credit.channelId === undefined ? {} : { channelId: credit.channelId };

    if (level > previousLevel) {
      this.#publish(
        guildId,
        'xp.level_gained',
        `${guildId}:${userId}:${level}`,
        xpLevelGainedSchema.parse({
          guildId,
          userId,
          level,
          previousLevel,
          xp,
          source: credit.source,
          ...channel,
          causation: credit.causation,
        }),
      );
    }

    this.#publish(
      guildId,
      'xp.awarded',
      credit.key,
      xpAwardedSchema.parse({
        guildId,
        userId,
        amount,
        source: credit.source,
        ...channel,
        activityAt: this.#clock.now,
        xp,
        level,
        causation: credit.causation,
      }),
    );
  }
}

export class FakeMailbox {
  readonly answers: Array<{ id: string; value: AchievementRetryOutcome }> = [];

  async answer(id: string, value: AchievementRetryOutcome): Promise<void> {
    this.answers.push({ id, value });
  }
}

export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface SendBody {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  allowed_mentions?: { parse?: string[] };
}

export interface SentMessage {
  channelId: string;
  body: SendBody;
}

export interface RoleCall {
  method: string;
  guildId: string;
  userId: string;
  roleId: string;
  status: number;
}

interface Slot {
  config: AchievementsConfig;
  enabled: boolean;
  overwrites: Map<string, Overwrite[]>;
}

interface Worker {
  listeners: readonly EventListener<AchievementsConfig>[];
  handlers: Readonly<Record<string, ScheduledHandler<AchievementsConfig>>>;
}

export interface EmitOptions {
  config?: AchievementsConfig;
  worker?: 'first' | 'second';
}

export interface ResetOptions {
  guildId?: string;
  allowRewardsAgain?: boolean;
}

export interface MessageOptions {
  id?: string;
  authorId?: string;
  channelId?: string;
  at?: number;
  roles?: string[];
  guildId?: string;
  bot?: boolean;
  type?: number;
}

export interface ReactionOptions {
  reactorId: string;
  authorId: string;
  messageId: string;
  channelId?: string;
  emoji?: string;
  at?: number;
  roles?: string[];
  guildId?: string;
}

export interface VoiceOptions {
  userId?: string;
  channelId: string | null;
  at?: number;
  selfDeaf?: boolean;
  selfMute?: boolean;
  roles?: string[];
  guildId?: string;
}

export interface LevelOptions {
  userId?: string;
  level: number;
  previousLevel?: number;
  channelId?: string;
  at?: number;
  guildId?: string;
}

export interface Harness<S extends AchievementStore = AchievementStore> {
  clock: { now: number };
  store: S;
  voice: AchievementVoiceStore;
  rest: FakeRest;
  recorder: MemoryRecorder;
  scheduler: FakeScheduler;
  leveling: FakeLeveling;
  mailbox: FakeMailbox;
  deps: AchievementsDeps;
  logs: CapturedLog[];
  published: ProtonEvent[];
  modules: Map<string, boolean>;
  botPermissions: bigint;

  configure(input: AchievementsConfigInput, guildId?: string): Promise<AchievementsConfig>;
  config(guildId?: string): AchievementsConfig;
  context(guildId?: string, config?: AchievementsConfig): ModuleContext<AchievementsConfig>;
  deny(channelId: string, bits: bigint, guildId?: string): void;

  emit(event: ProtonEvent, options?: EmitOptions): Promise<void>;
  redeliver(type: EventType): Promise<void>;
  drain(): Promise<void>;
  hold(): void;
  release(): Promise<void>;

  advance(ms: number): void;
  tick(ms: number, step?: number): Promise<void>;
  runDue(): Promise<void>;
  gainXp(userId: string, amount: number, channelId?: string, guildId?: string): Promise<void>;
  crashAfter(method: keyof AchievementStore, times?: number): void;

  resetMember(
    userId: string,
    achievementIds: readonly string[],
    options?: ResetOptions,
  ): Promise<void>;
  resetAchievement(achievementId: string, options?: ResetOptions): Promise<void>;

  sends(channelId?: string): SentMessage[];
  roleCalls(): RoleCall[];
  ofType(type: EventType): ProtonEvent[];
  unlocks(userId: string, guildId?: string): Promise<UnlockRow[]>;
  rewards(userId: string, achievementId: string, guildId?: string): Promise<RewardRow[]>;
  value(
    userId: string,
    achievementId: string,
    requirementId: string,
    guildId?: string,
  ): Promise<number>;

  message(options?: MessageOptions): ProtonEvent;
  reaction(options: ReactionOptions): ProtonEvent;
  voiceUpdate(options: VoiceOptions): ProtonEvent;
  levelGained(options: LevelOptions): ProtonEvent;
  memberLeft(userId: string, guildId?: string): ProtonEvent;
  jobRequested(
    achievementId: string,
    job: 'rebuild' | 'rebuild_preview' | 'recheck',
    options?: { announce?: boolean; acceptLoss?: boolean; guildId?: string },
  ): ProtonEvent;
  retryRequested(rewards: AchievementRewardRef[], guildId?: string): ProtonEvent;
}

export interface HarnessParts<S extends AchievementStore> {
  store: S;
  setModule(guildId: string, enabled: boolean, config: AchievementsConfig): Promise<void> | void;
  clock: { now: number };
  voice?: AchievementVoiceStore;
  locks?: FencedLocks;
  limits?: AchievementLimits;
  dedupe?: DedupeStore;
  botPermissions?: bigint;
  deps?: Partial<AchievementsDeps>;
}

export interface HarnessOptions {
  start?: number;
  botPermissions?: bigint;
  deps?: Partial<AchievementsDeps>;
}

export function harness(options: HarnessOptions = {}): Harness<MemoryAchievementStore> {
  const clock = { now: options.start ?? T0 };
  const now = () => clock.now;
  const store = new MemoryAchievementStore({ now });

  return harnessOver({
    store,
    setModule: (guildId, enabled, config) => store.setModule(guildId, { enabled, config }),
    clock,
    voice: new MemoryAchievementVoiceStore({ now }),
    locks: new MemoryFencedLocks({ now }),
    limits: new MemoryLimits({ now }),
    ...(options.botPermissions === undefined ? {} : { botPermissions: options.botPermissions }),
    ...(options.deps ? { deps: options.deps } : {}),
  });
}

function channelOf(
  id: string,
  parentId: string | null,
  type: number,
  name: string,
  overwrites: ReadonlyMap<string, Overwrite[]>,
): [string, ChannelState] {
  return [id, { id, parentId, type, name, overwrites: overwrites.get(id) ?? [] }];
}

function guildState(
  guildId: string,
  botPermissions: bigint,
  overwrites: ReadonlyMap<string, Overwrite[]>,
): GuildState {
  return {
    guildId,
    ownerId: OWNER,
    everyoneRoleId: guildId,
    roles: new Map<string, GuildRole>([
      [guildId, { id: guildId, permissions: Permissions.ViewChannel, position: 0 }],
      [MEMBER_ROLE, { id: MEMBER_ROLE, permissions: 0n, position: 1 }],
      [REWARD_ROLE, { id: REWARD_ROLE, permissions: 0n, position: 2 }],
      [SECOND_REWARD_ROLE, { id: SECOND_REWARD_ROLE, permissions: 0n, position: 3 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5, managed: true }],
      [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: 9 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      channelOf(CATEGORY, null, 4, 'community', overwrites),
      channelOf(TEXT, CATEGORY, 0, 'general', overwrites),
      channelOf(OTHER_TEXT, CATEGORY, 0, 'off-topic', overwrites),
      channelOf(ANNOUNCE, null, 0, 'achievements', overwrites),
      channelOf(VOICE, CATEGORY, 2, 'lounge', overwrites),
      channelOf(AFK_VOICE, null, 2, 'afk', overwrites),
    ]),
    name: 'Proton test',
    afkChannelId: AFK_VOICE,
    updatedAt: T0,
  };
}

const memberSchema = z.object({
  user: z.object({ bot: z.boolean().optional() }).optional(),
  roles: z.array(z.string()).default([]),
  joined_at: z.string().nullish(),
  premium_since: z.string().nullish(),
});

function epochOf(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

function isNotMember(response: RestResponse): boolean {
  const code = (response.body as { code?: unknown } | null)?.code;
  return response.status === 404 && (code === 10007 || code === 10013);
}

function memberRolesOver(rest: RestProxyClient) {
  return async (guildId: string, userId: string): Promise<MemberRolesLookup> => {
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
    });
    if (isNotMember(response)) return 'not_member';
    if (response.status >= 400) return null;
    return memberSchema.parse(response.body).roles;
  };
}

function memberFactsOver(rest: RestProxyClient) {
  return async (guildId: string, userId: string): Promise<MemberLookup | null> => {
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
    });
    if (isNotMember(response)) return null;
    if (response.status >= 400) {
      throw new Error(
        `reading their membership of ${guildId} failed: Discord answered ${response.status}`,
      );
    }

    const member = memberSchema.parse(response.body);
    return {
      roleIds: member.roles,
      bot: member.user?.bot === true,
      joinedAt: epochOf(member.joined_at),
      premiumSince: epochOf(member.premium_since),
    };
  };
}

function guarded(
  inner: ActionExecutor,
): ActionExecutor & { scoped(hints: unknown): ActionExecutor } {
  return {
    async execute(request) {
      if (!ACTION_KINDS.includes(request.kind)) {
        throw new Error(
          `achievements tried to execute '${request.kind}', which its manifest does not declare in actionKinds`,
        );
      }
      return inner.execute(request);
    },
    scoped(hints) {
      return guarded(isScopedActionExecutor(inner) ? inner.scoped(hints) : inner);
    },
  };
}

function auditEntry(guildId: string, subject: string): NewAuditTrailEntry {
  return {
    id: newId(),
    guildId,
    actorId: STAFF,
    source: 'dashboard',
    action: 'module.achievements.reset',
    before: null,
    after: { reset: subject },
  };
}

function changedKeys(before: AchievementsConfig, after: AchievementsConfig): string[] {
  return Object.keys(after).filter(
    (key) => JSON.stringify(Reflect.get(before, key)) !== JSON.stringify(Reflect.get(after, key)),
  );
}

export function harnessOver<S extends AchievementStore>(parts: HarnessParts<S>): Harness<S> {
  const { clock, store } = parts;
  const now = () => clock.now;
  const permissions = { bits: parts.botPermissions ?? BOT_PERMISSIONS };

  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const scheduler = new FakeScheduler();
  const mailbox = new FakeMailbox();
  const modules = new Map<string, boolean>();
  const logs: CapturedLog[] = [];
  const published: ProtonEvent[] = [];
  const queue: ProtonEvent[] = [];
  const bus = { held: false };

  const voice = parts.voice ?? new MemoryAchievementVoiceStore({ now });
  const locks = parts.locks ?? new MemoryFencedLocks({ now });
  const limits = parts.limits ?? new MemoryLimits({ now });

  const slots = new Map<string, Slot>();
  for (const guildId of [GUILD, OTHER_GUILD]) {
    slots.set(guildId, {
      config: achievementsDefaultConfig,
      enabled: false,
      overwrites: new Map(),
    });
    for (const userId of MEMBERS) rest.join(guildId, userId);
  }

  const slotOf = (guildId: string): Slot => {
    const slot = slots.get(guildId);
    if (!slot) throw new Error(`the harness knows no server ${guildId}`);
    return slot;
  };

  const publishEvent: Publish = (guildId, type, naturalKey, payload) => {
    const event: ProtonEvent = {
      id: `${type}:${guildId}:${naturalKey}`,
      type,
      guildId,
      occurredAt: clock.now,
      payload,
    };
    published.push(event);
    queue.push(event);
  };

  const leveling = new FakeLeveling(publishEvent, clock);

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const guildStore: GuildStateStore = {
    get: async (guildId) => {
      const slot = slots.get(guildId);
      return slot ? guildState(guildId, permissions.bits, slot.overwrites) : null;
    },
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const executor = new DefaultActionExecutor({
    dedupe: parts.dedupe ?? new MemoryDedupe(),
    rest,
    recorder,
    resolveContext: async (
      request,
      hints,
    ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
      const resolved = await resolvePrecheckContext(
        { store: guildStore, botUserId: PROTON, fetchMemberRoles: memberRolesOver(rest) },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const deps: AchievementsDeps = {
    store,
    voice,
    locks,
    limits,
    guildState: guildStore,
    availability: {
      isEnabled: async (guildId, moduleId) =>
        moduleId === MODULE_ID ? slotOf(guildId).enabled : (modules.get(moduleId) ?? true),
    },
    memberFacts: memberFactsOver(rest),
    levelOf: async (guildId, userId) => leveling.levelOf(guildId, userId),
    channelKind: async () => null,
    mailbox,
    applicationId: PROTON,
    botUserId: PROTON,
    now,
    ...parts.deps,
  };

  const workerOf = (from: AchievementsDeps): Worker => {
    const manifest = createAchievementsModule(from);
    return { listeners: manifest.listeners ?? [], handlers: manifest.scheduledHandlers ?? {} };
  };

  const workers = { first: workerOf(deps), second: workerOf({ ...deps }) };

  const context = (
    guildId: string = GUILD,
    config?: AchievementsConfig,
  ): ModuleContext<AchievementsConfig> => ({
    guildId,
    config: config ?? slotOf(guildId).config,
    tier: 'free',
    executor: guarded(executor),
    logger,
    publish: async (type, naturalKey, payload) => {
      if (!EMITS.includes(type)) {
        throw new Error(
          `achievements tried to publish '${type}', which its manifest does not emit`,
        );
      }
      publishEvent(guildId, type, naturalKey, payload);
    },
    schedule: async (jobId, runAt, naturalKey, data, options) => {
      if (!SCHEDULES.includes(jobId)) {
        throw new Error(
          `achievements tried to schedule '${jobId}', which its manifest does not declare`,
        );
      }
      return scheduler.schedule(guildId, jobId, runAt, naturalKey, data, options);
    },
    cancel: async (jobId, naturalKey) => scheduler.cancel(guildId, jobId, naturalKey),
  });

  const deliver = async (event: ProtonEvent, options: EmitOptions = {}): Promise<void> => {
    const guildId = event.guildId;
    if (guildId === null) return;

    if (event.type === 'xp.grant_requested') {
      if (modules.get('leveling') !== false) leveling.answer(event);
      return;
    }

    const slot = slots.get(guildId);
    if (!slot || (!slot.enabled && event.type !== 'proton.config_changed')) return;

    const worker = options.worker === 'second' ? workers.second : workers.first;
    const ctx = context(guildId, options.config);
    for (const listener of worker.listeners) {
      if (listener.types.includes(event.type)) await listener.handler(event, ctx);
    }
  };

  const drain = async (): Promise<void> => {
    for (let delivered = 0; !bus.held && queue.length > 0; delivered++) {
      if (delivered >= DRAIN_LIMIT) {
        throw new Error(`the bus never went quiet: ${DRAIN_LIMIT} events and counting`);
      }
      const event = queue.shift();
      if (event) await deliver(event);
    }
  };

  const emit = async (event: ProtonEvent, options: EmitOptions = {}): Promise<void> => {
    let failure: { error: unknown } | null = null;
    try {
      await deliver(event, options);
    } catch (error) {
      failure = { error };
    }
    await drain();
    if (failure) throw failure.error;
  };

  const runDue = async (): Promise<void> => {
    for (let runs = 0; ; runs++) {
      const job = scheduler.due(clock.now);
      if (!job) return;
      if (runs >= JOB_LIMIT) throw new Error(`the scheduler never went quiet: ${JOB_LIMIT} runs`);

      scheduler.take(job);
      if (!slots.get(job.guildId)?.enabled) continue;

      const handler = workers.first.handlers[job.jobId];
      if (!handler) throw new Error(`achievements has no handler for the '${job.jobId}' job`);

      try {
        await handler(job.data, context(job.guildId));
      } catch (error) {
        scheduler.restore(job);
        await drain();
        throw error;
      }
      await drain();
    }
  };

  const ofType = (type: EventType): ProtonEvent[] =>
    published.filter((event) => event.type === type);

  let jobRequests = 0;

  return {
    clock,
    store,
    voice,
    rest,
    recorder,
    scheduler,
    leveling,
    mailbox,
    deps,
    logs,
    published,
    modules,

    get botPermissions() {
      return permissions.bits;
    },
    set botPermissions(bits: bigint) {
      permissions.bits = bits;
    },

    async configure(input, guildId = GUILD) {
      const slot = slotOf(guildId);
      const before = slot.config;
      const wasEnabled = slot.enabled;
      const next = achievementsConfigSchema.parse({
        enabled: true,
        messageCooldown: '0s',
        ...input,
      });

      const issues = validateConfig(next, before, clock.now);
      if (issues.length > 0) {
        throw new Error(
          `the api would refuse this config: ${issues.map(({ path, message }) => `${path}: ${message}`).join('; ')}`,
        );
      }

      slot.config = next;
      slot.enabled = next.enabled;
      await parts.setModule(guildId, next.enabled, next);

      const auditId = newId();
      await emit({
        id: `proton.config_changed:${guildId}:${auditId}`,
        type: 'proton.config_changed',
        guildId,
        occurredAt: clock.now,
        payload: {
          auditId,
          guildId,
          moduleId: MODULE_ID,
          actorId: STAFF,
          source: 'dashboard',
          enabledBefore: wasEnabled,
          enabledAfter: next.enabled,
          changedKeys: changedKeys(before, next),
        },
      });

      return next;
    },

    config: (guildId = GUILD) => slotOf(guildId).config,
    context,

    deny(channelId, bits, guildId = GUILD) {
      const overwrites = slotOf(guildId).overwrites;
      overwrites.set(channelId, [
        ...(overwrites.get(channelId) ?? []),
        { id: BOT_ROLE, type: 0, allow: 0n, deny: bits },
      ]);
    },

    emit,

    async redeliver(type) {
      for (const event of ofType(type)) await emit(event);
    },

    drain,

    hold() {
      bus.held = true;
    },

    async release() {
      bus.held = false;
      await drain();
    },

    advance(ms) {
      clock.now += ms;
    },

    async tick(ms, step = ms) {
      const end = clock.now + ms;
      do {
        clock.now = Math.min(end, clock.now + Math.max(1, step));
        await runDue();
      } while (clock.now < end);
    },

    runDue,

    async gainXp(userId, amount, channelId, guildId = GUILD) {
      leveling.gain(guildId, userId, amount, channelId);
      await drain();
    },

    crashAfter(method, times = 1) {
      const original: unknown = Reflect.get(store, method);
      if (typeof original !== 'function') throw new Error(`the store has no ${String(method)}`);
      let left = times;

      Reflect.set(store, method, async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(original, store, args);
        if (left > 0) {
          left -= 1;
          throw new Error(`the worker died right after ${String(method)}`);
        }
        return result;
      });
    },

    async resetMember(userId, achievementIds, options = {}) {
      const guildId = options.guildId ?? GUILD;
      await store.resetMember({
        guildId,
        achievementIds,
        userId,
        allowRewardsAgain: options.allowRewardsAgain ?? false,
        actorId: STAFF,
        at: clock.now,
        audit: auditEntry(guildId, userId),
      });
    },

    async resetAchievement(achievementId, options = {}) {
      const guildId = options.guildId ?? GUILD;
      await store.resetAchievement({
        guildId,
        achievementId,
        allowRewardsAgain: options.allowRewardsAgain ?? false,
        actorId: STAFF,
        at: clock.now,
        audit: auditEntry(guildId, achievementId),
      });
    },

    sends: (channelId) =>
      rest.exchanges.flatMap(({ request, status }) => {
        const target = MESSAGE_PATH.exec(request.path)?.[1];
        if (request.method !== 'POST' || !target || status >= 400) return [];
        if (channelId !== undefined && target !== channelId) return [];
        return [{ channelId: target, body: request.body as SendBody }];
      }),

    roleCalls: () =>
      rest.exchanges.flatMap(({ request, status }) => {
        const match = ROLE_PATH.exec(request.path);
        if (!match || (request.method !== 'PUT' && request.method !== 'DELETE')) return [];
        const [, guildId = '', userId = '', roleId = ''] = match;
        return [{ method: request.method, guildId, userId, roleId, status }];
      }),

    ofType,

    unlocks: (userId, guildId = GUILD) => store.unlocksOf(guildId, userId),

    async rewards(userId, achievementId, guildId = GUILD) {
      const [state] = await store.memberStates(guildId, userId, [achievementId]);
      return store.rewardsFor(guildId, userId, achievementId, state?.generation ?? 0);
    },

    async value(userId, achievementId, requirementId, guildId = GUILD) {
      const [state] = await store.memberStates(guildId, userId, [achievementId]);
      const requirement = slotOf(guildId)
        .config.achievements.find(({ id }) => id === achievementId)
        ?.requirements.find(({ id }) => id === requirementId);
      return state && requirement ? requirementValue(state, requirementId, requirement.version) : 0;
    },

    message(options = {}) {
      const at = options.at ?? clock.now;
      const guildId = options.guildId ?? GUILD;
      const id = options.id ?? snowflakeAt(at);
      const recorded = dispatch('messageCreate').d;

      return {
        id: `message.created:${id}`,
        type: 'message.created',
        guildId,
        occurredAt: at,
        payload: {
          ...recorded,
          id,
          guild_id: guildId,
          channel_id: options.channelId ?? TEXT,
          timestamp: new Date(at).toISOString(),
          type: options.type ?? 0,
          author: {
            ...(recorded.author as Record<string, unknown>),
            id: options.authorId ?? MEMBER,
            bot: options.bot ?? false,
          },
          member: {
            roles: options.roles ?? [MEMBER_ROLE],
            joined_at: JOINED_AT,
            premium_since: null,
          },
        },
      };
    },

    reaction(options) {
      const at = options.at ?? clock.now;
      const guildId = options.guildId ?? GUILD;
      const emoji = options.emoji ?? '⭐';

      return {
        id: `reaction.added:${guildId}:${options.messageId}:${options.reactorId}:${next()}`,
        type: 'reaction.added',
        guildId,
        occurredAt: at,
        payload: {
          ...dispatch('messageReactionAdd').d,
          user_id: options.reactorId,
          channel_id: options.channelId ?? TEXT,
          message_id: options.messageId,
          guild_id: guildId,
          message_author_id: options.authorId,
          emoji: { id: null, name: emoji },
          member: {
            user: { id: options.reactorId, bot: false },
            roles: options.roles ?? [MEMBER_ROLE],
            joined_at: JOINED_AT,
          },
        },
      };
    },

    voiceUpdate(options) {
      const at = options.at ?? clock.now;
      const guildId = options.guildId ?? GUILD;
      const userId = options.userId ?? MEMBER;

      return {
        id: `voice.state_updated:${guildId}:${userId}:${next()}`,
        type: 'voice.state_updated',
        guildId,
        occurredAt: at,
        payload: {
          guild_id: guildId,
          channel_id: options.channelId,
          user_id: userId,
          session_id: 'voice-session',
          deaf: false,
          mute: false,
          self_deaf: options.selfDeaf ?? false,
          self_mute: options.selfMute ?? false,
          self_video: false,
          suppress: false,
          member: {
            user: { id: userId, bot: false },
            roles: options.roles ?? [MEMBER_ROLE],
            joined_at: JOINED_AT,
            premium_since: null,
          },
        },
      };
    },

    levelGained(options) {
      const guildId = options.guildId ?? GUILD;
      const userId = options.userId ?? MEMBER;

      return {
        id: `xp.level_gained:${guildId}:${userId}:${options.level}:${next()}`,
        type: 'xp.level_gained',
        guildId,
        occurredAt: options.at ?? clock.now,
        payload: xpLevelGainedSchema.parse({
          guildId,
          userId,
          level: options.level,
          previousLevel: options.previousLevel ?? Math.max(0, options.level - 1),
          xp: options.level * XP_PER_LEVEL,
          source: 'message',
          ...(options.channelId === undefined ? {} : { channelId: options.channelId }),
        }),
      };
    },

    memberLeft(userId, guildId = GUILD) {
      return {
        id: `member.left:${guildId}:${userId}:${next()}`,
        type: 'member.left',
        guildId,
        occurredAt: clock.now,
        payload: { guild_id: guildId, user: { id: userId, username: 'gone', bot: false } },
      };
    },

    jobRequested(achievementId, job, options = {}) {
      const guildId = options.guildId ?? GUILD;
      jobRequests += 1;
      const requestId = `job-request-${jobRequests}`;

      return {
        id: `achievements.job_requested:${guildId}:${requestId}`,
        type: 'achievements.job_requested',
        guildId,
        occurredAt: clock.now,
        payload: {
          requestId,
          guildId,
          actorId: STAFF,
          achievementId,
          job,
          announce: options.announce ?? false,
          acceptLoss: options.acceptLoss ?? false,
        },
      };
    },

    retryRequested(rewards, guildId = GUILD) {
      const requestId = `retry-request-${next()}`;

      return {
        id: `achievements.reward_retry_requested:${guildId}:${requestId}`,
        type: 'achievements.reward_retry_requested',
        guildId,
        occurredAt: clock.now,
        payload: { requestId, guildId, actorId: STAFF, rewards },
      };
    },
  };
}

export function refOf(row: RewardRow): AchievementRewardRef {
  return {
    userId: row.userId,
    achievementId: row.achievementId,
    tierId: row.tierId,
    generation: row.generation,
    rewardKey: row.rewardKey,
  };
}

export function snapshotOf(store: MemoryAchievementStore): string {
  return JSON.stringify(
    {
      seen: store.seen,
      activity: store.activity,
      progress: store.progress,
      members: store.members,
      states: store.states,
      periods: store.periods,
      unlocks: store.unlocks,
      rewards: store.rewards,
      facts: store.factRows,
      badges: store.badges,
      modules: store.modules,
      audits: store.audits,
    },
    (_key, value: unknown) =>
      value instanceof Map
        ? [...value.entries()]
        : typeof value === 'bigint'
          ? value.toString()
          : value,
  );
}
