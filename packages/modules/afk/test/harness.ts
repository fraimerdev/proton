import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  OptionType,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
  type ScheduleOptions,
  type ScheduleOutcome,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { type AfkConfig, afkDefaultConfig, RECAP_MAX } from '../src/config.ts';
import type { AfkDeps } from '../src/deps.ts';
import { createAfkModule } from '../src/index.ts';
import type {
  AfkPing,
  AfkStatus,
  AfkStore,
  RecordPingInput,
  StartAfkInput,
  StartAfkResult,
} from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '100000000000000001';
export const OTHER = '100000000000000002';
export const STAFF = '100000000000000003';
export const ABOVE_BOT = '100000000000000004';
export const CHANNEL = '500000000000000001';
export const QUIET_CHANNEL = '500000000000000002';
export const THREAD = '500000000000000003';
export const DM_CHANNEL = '500000000000000099';
export const APPLICATION_ID = '1200000000000000001';

const EVERYONE_ROLE = GUILD;
export const LOW_ROLE = '410000000000000001';
const BOT_ROLE = '410000000000000005';
export const HIGH_ROLE = '410000000000000009';

export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.SendMessagesInThreads |
  Permissions.ReadMessageHistory |
  Permissions.ManageNicknames |
  Permissions.ManageMessages;

const MEMBER_ROLES: Record<string, string[]> = {
  [MEMBER]: [LOW_ROLE],
  [OTHER]: [LOW_ROLE],
  [STAFF]: [LOW_ROLE],
  [OWNER]: [LOW_ROLE],
  [ABOVE_BOT]: [HIGH_ROLE],
};

export function rolesOf(userId: string): string[] {
  return MEMBER_ROLES[userId] ?? [];
}

let sequence = 0;

export function snowflake(prefix = '8'): string {
  sequence += 1;
  return `${prefix}${String(sequence).padStart(18, '0')}`;
}

function guildState(botPermissions: bigint): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [LOW_ROLE, { id: LOW_ROLE, permissions: 0n, position: 1 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
      [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: 9 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }],
      [QUIET_CHANNEL, { id: QUIET_CHANNEL, parentId: null, overwrites: [] }],
      [THREAD, { id: THREAD, parentId: QUIET_CHANNEL, type: 11, overwrites: [] }],
    ]),
    updatedAt: Date.now(),
  };
}

function newestFirst(a: AfkPing, b: AfkPing): number {
  const byTime = b.pingedAt.getTime() - a.pingedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0;
}

export class MemoryAfkStore implements AfkStore {
  readonly statuses = new Map<string, AfkStatus>();
  pingRows: AfkPing[] = [];

  #bySession(sessionId: string): AfkStatus | undefined {
    return [...this.statuses.values()].find((status) => status.sessionId === sessionId);
  }

  async start(input: StartAfkInput): Promise<StartAfkResult> {
    const key = `${input.guildId}:${input.userId}`;
    const existing = this.statuses.get(key);
    if (existing) return { status: { ...existing }, created: false };

    const status: AfkStatus = { ...input, appliedNick: null, endedAt: null, endedBy: null };
    this.statuses.set(key, status);
    return { status: { ...status }, created: true };
  }

  async get(guildId: string, userId: string): Promise<AfkStatus | null> {
    const status = this.statuses.get(`${guildId}:${userId}`);
    return status ? { ...status } : null;
  }

  async active(guildId: string, userIds: readonly string[]): Promise<AfkStatus[]> {
    return [...this.statuses.values()]
      .filter(
        (status) =>
          status.guildId === guildId && userIds.includes(status.userId) && status.endedAt === null,
      )
      .map((status) => ({ ...status }));
  }

  async all(guildId: string): Promise<AfkStatus[]> {
    return [...this.statuses.values()]
      .filter((status) => status.guildId === guildId)
      .map((status) => ({ ...status }));
  }

  async updateReason(
    guildId: string,
    userId: string,
    reason: string | null,
  ): Promise<AfkStatus | null> {
    const status = this.statuses.get(`${guildId}:${userId}`);
    if (!status || status.endedAt !== null) return null;

    status.reason = reason;
    return { ...status };
  }

  async setAppliedNick(sessionId: string, appliedNick: string | null): Promise<void> {
    const status = this.#bySession(sessionId);
    if (status) status.appliedNick = appliedNick;
  }

  async recordTag(sessionId: string, nick: string): Promise<boolean> {
    const status = this.#bySession(sessionId);
    if (!status || status.endedAt !== null) return false;

    status.appliedNick = nick;
    return true;
  }

  async recordPing(sessionId: string, input: RecordPingInput): Promise<boolean> {
    const status = this.#bySession(sessionId);
    if (!status || status.endedAt !== null) return false;

    const duplicate = this.pingRows.some(
      (ping) => ping.sessionId === sessionId && ping.messageId === input.messageId,
    );
    if (duplicate) return false;

    this.pingRows.push({ sessionId, ...input });

    const kept = new Set(
      this.pingRows
        .filter((ping) => ping.sessionId === sessionId)
        .sort(newestFirst)
        .slice(0, RECAP_MAX),
    );
    this.pingRows = this.pingRows.filter((ping) => ping.sessionId !== sessionId || kept.has(ping));

    return true;
  }

  async pings(sessionId: string): Promise<AfkPing[]> {
    return this.pingRows.filter((ping) => ping.sessionId === sessionId).sort(newestFirst);
  }

  async markEnded(sessionId: string, endedBy: string): Promise<AfkStatus | null> {
    const status = this.#bySession(sessionId);
    if (!status) return null;
    if (status.endedAt !== null && status.endedBy !== endedBy) return null;

    status.endedAt ??= new Date();
    status.endedBy = endedBy;
    return { ...status };
  }

  async finishSession(sessionId: string): Promise<void> {
    const status = this.#bySession(sessionId);
    if (status && status.endedAt !== null) {
      status.reason = null;
      status.previousNick = null;
      status.appliedNick = null;
    }
    this.pingRows = this.pingRows.filter((ping) => ping.sessionId !== sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    for (const [key, status] of this.statuses) {
      if (status.sessionId === sessionId) this.statuses.delete(key);
    }
    this.pingRows = this.pingRows.filter((ping) => ping.sessionId !== sessionId);
  }

  async removeMember(guildId: string, userId: string): Promise<void> {
    this.statuses.delete(`${guildId}:${userId}`);
    this.pingRows = this.pingRows.filter(
      (ping) => ping.guildId !== guildId || ping.userId !== userId,
    );
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

class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

export class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  readonly sentIds: string[] = [];
  readonly #failures: Array<{ method: string; path: string; status: number }> = [];
  readonly #intercepts: Array<{ method: string; path: string; run: () => Promise<void> }> = [];

  fail(method: string, pathPrefix: string, status: number): void {
    this.#failures.push({ method, path: pathPrefix, status });
  }

  intercept(method: string, pathPrefix: string, run: () => Promise<void>): void {
    this.#intercepts.push({ method, path: pathPrefix, run });
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const hooked = this.#intercepts.findIndex(
      (entry) => entry.method === options.method && options.path.startsWith(entry.path),
    );
    if (hooked !== -1) await this.#intercepts.splice(hooked, 1)[0]?.run();

    const failure = this.#failures.find(
      (entry) => entry.method === options.method && options.path.startsWith(entry.path),
    );
    if (failure) return { status: failure.status, body: { message: 'refused by the test' } };

    if (options.method === 'POST' && options.path === '/users/@me/channels') {
      return { status: 200, body: { id: DM_CHANNEL, type: 1 } };
    }

    if (options.method === 'POST' && /^\/channels\/\d+\/messages$/.test(options.path)) {
      const id = snowflake('7');
      this.sentIds.push(id);
      return { status: 200, body: { id } };
    }

    if (options.method === 'DELETE') return { status: 204, body: null };

    return { status: 200, body: {} };
  }
}

export interface BookedJob {
  jobId: string;
  runAt: Date;
  naturalKey: string;
  data: unknown;
  options?: ScheduleOptions;
}

export class FakeScheduler {
  readonly booked: BookedJob[] = [];
  readonly cancelled: Array<{ jobId: string; naturalKey: string }> = [];
  #pending: BookedJob[] = [];

  pending(jobId: string): BookedJob[] {
    return this.#pending.filter((job) => job.jobId === jobId);
  }

  #without(jobId: string, naturalKey: string): BookedJob[] {
    return this.#pending.filter((job) => job.jobId !== jobId || job.naturalKey !== naturalKey);
  }

  schedule = async (
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<ScheduleOutcome> => {
    const job: BookedJob = { jobId, runAt, naturalKey, data, ...(options ? { options } : {}) };
    this.booked.push(job);

    const held = this.#pending.some(
      (pending) => pending.jobId === jobId && pending.naturalKey === naturalKey,
    );
    if (held && !options?.replace) return { scheduled: false, replaced: false };

    this.#pending = [...this.#without(jobId, naturalKey), job];
    return { scheduled: true, replaced: held };
  };

  cancel = async (jobId: string, naturalKey: string): Promise<void> => {
    this.cancelled.push({ jobId, naturalKey });
    this.#pending = this.#without(jobId, naturalKey);
  };
}

export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface SendBody {
  content?: string;
  flags?: number;
  allowed_mentions?: { parse?: string[] };
  message_reference?: { message_id?: string; fail_if_not_exists?: boolean };
}

export interface CallbackBody {
  type?: number;
  data?: { content?: string };
}

export interface Sent {
  channelId: string;
  body: SendBody;
}

export interface CommandOverrides {
  userId: string;
  interactionId: string;
  idempotencyKey: string;
  config: Partial<AfkConfig>;
  deps: AfkDeps;
  actorNick: string | null | undefined;
  actorDisplayName: string | undefined;
  actorRoleIds: string[] | undefined;
  actorPermissions: bigint | undefined;
  scheduler: boolean;
}

export interface ContextOverrides {
  config: Partial<AfkConfig>;
  deps: AfkDeps;
  scheduler: boolean;
}

export interface Harness {
  rest: FakeRest;
  store: MemoryAfkStore;
  scheduler: FakeScheduler;
  recorder: MemoryRecorder;
  logs: CapturedLog[];
  botPermissions: bigint;

  run(sub: string, options?: RawOption[], overrides?: Partial<CommandOverrides>): Promise<void>;
  emit(event: ProtonEvent, overrides?: Partial<ContextOverrides>): Promise<void>;
  job(jobId: string, data: unknown, overrides?: Partial<ContextOverrides>): Promise<void>;

  followUps(): SendBody[];
  lastFollowUp(): string | null;
  sends(): Sent[];
  nicknames(): Array<{ userId: string; nick: string | null }>;
  deletes(): string[];
  dmOpens(): number;
}

export interface HarnessOptions {
  deps?: AfkDeps;
  botPermissions?: bigint;
}

export function harness(options: HarnessOptions = {}): Harness {
  const permissions = { bits: options.botPermissions ?? BOT_PERMISSIONS };

  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const scheduler = new FakeScheduler();
  const store = new MemoryAfkStore();
  const logs: CapturedLog[] = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const guildStore: GuildStateStore = {
    get: async () => guildState(permissions.bits),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const executor = new DefaultActionExecutor({
    dedupe,
    rest,
    recorder,
    resolveContext: async (
      request,
      hints,
    ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
      const resolved = await resolvePrecheckContext(
        {
          store: guildStore,
          botUserId: BOT,
          fetchMemberRoles: async (_guildId, userId) => rolesOf(userId),
        },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const depsOf = (deps: AfkDeps | undefined): AfkDeps =>
    deps ?? options.deps ?? { store, applicationId: APPLICATION_ID, guildState: guildStore };

  const configOf = (config: Partial<AfkConfig> = {}): AfkConfig => ({
    ...afkDefaultConfig,
    enabled: true,
    ...config,
  });

  const timers = (enabled: boolean | undefined) =>
    enabled === false ? {} : { schedule: scheduler.schedule, cancel: scheduler.cancel };

  const contextOf = (overrides: Partial<ContextOverrides>): ModuleContext<AfkConfig> => ({
    guildId: GUILD,
    config: configOf(overrides.config),
    tier: 'free',
    executor,
    logger,
    ...timers(overrides.scheduler),
  });

  const followUps = (): SendBody[] =>
    rest.calls
      .filter((call) => call.path.startsWith('/webhooks/'))
      .map((call) => call.body as SendBody);

  return {
    rest,
    store,
    scheduler,
    recorder,
    logs,

    get botPermissions() {
      return permissions.bits;
    },
    set botPermissions(bits: bigint) {
      permissions.bits = bits;
    },

    async run(sub, subOptions = [], overrides = {}) {
      const command = createAfkModule(depsOf(overrides.deps)).commands?.find(
        (candidate) => candidate.name === 'afk',
      );
      if (!command) throw new Error('the afk module registered no /afk command');

      const userId = overrides.userId ?? MEMBER;
      const interactionId = overrides.interactionId ?? snowflake('6');

      const actorNick = 'actorNick' in overrides ? overrides.actorNick : 'Bob';
      const actorDisplayName = 'actorDisplayName' in overrides ? overrides.actorDisplayName : 'bob';
      const actorRoleIds = 'actorRoleIds' in overrides ? overrides.actorRoleIds : rolesOf(userId);
      const actorPermissions = overrides.actorPermissions;

      const ctx: CommandContext<AfkConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId,
        config: configOf(overrides.config),
        tier: 'free',
        executor: executor.scoped({ channelId: CHANNEL, appPermissions: permissions.bits }),
        logger,
        options: createCommandOptions([
          { name: sub, type: OptionType.Subcommand, options: subOptions },
        ]),
        interaction: { id: interactionId, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? `interaction.command:${interactionId}`,

        ...(actorNick === undefined ? {} : { actorNick }),
        ...(actorDisplayName === undefined ? {} : { actorDisplayName }),
        ...(actorRoleIds === undefined ? {} : { actorRoleIds }),
        ...(actorPermissions === undefined ? {} : { actorPermissions }),
        ...timers(overrides.scheduler),
      };

      await command.handler(ctx);
    },

    async emit(event, overrides = {}) {
      for (const listener of createAfkModule(depsOf(overrides.deps)).listeners ?? []) {
        if (listener.types.includes(event.type)) {
          await listener.handler(event, contextOf(overrides));
        }
      }
    },

    async job(jobId, data, overrides = {}) {
      const handler = createAfkModule(depsOf(overrides.deps)).scheduledHandlers?.[jobId];
      if (!handler) throw new Error(`the afk module has no handler for '${jobId}'`);

      await handler(data, contextOf(overrides));
    },

    followUps,
    lastFollowUp: () => followUps().at(-1)?.content ?? null,

    sends: () =>
      rest.calls.flatMap((call) => {
        const channelId = /^\/channels\/(\d+)\/messages$/.exec(call.path)?.[1];
        return call.method === 'POST' && channelId
          ? [{ channelId, body: call.body as SendBody }]
          : [];
      }),

    nicknames: () =>
      rest.calls.flatMap((call) => {
        const userId = /^\/guilds\/\d+\/members\/(\d+)$/.exec(call.path)?.[1];
        if (call.method !== 'PATCH' || !userId) return [];
        return [{ userId, nick: (call.body as { nick: string | null }).nick }];
      }),

    deletes: () => rest.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),

    dmOpens: () =>
      rest.calls.filter((call) => call.method === 'POST' && call.path === '/users/@me/channels')
        .length,
  };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}

export interface MentionOptions {
  nick?: string | null;
  globalName?: string | null;
  username?: string;
  bot?: boolean;
}

export interface MentionPayload {
  id: string;
  username: string;
  global_name: string | null;
  bot: boolean;
  member?: { nick: string | null; roles: string[] };
}

export function mention(id: string, options: MentionOptions = {}): MentionPayload {
  return {
    id,
    username: options.username ?? 'mentioned',
    global_name: options.globalName ?? null,
    bot: options.bot ?? false,
    ...(options.nick === undefined ? {} : { member: { nick: options.nick, roles: [] } }),
  };
}

export interface MessageOptions {
  id?: string;
  authorId?: string;
  channelId?: string;
  nick?: string | null;
  member?: boolean;
  roles?: string[];
  mentions?: MentionPayload[];
  at?: number;
  bot?: boolean;
  webhook?: boolean;
  type?: number;
  username?: string;
  globalName?: string | null;
}

export function messageEvent(options: MessageOptions = {}): ProtonEvent {
  const recorded = dispatch('messageCreate').d;
  const id = options.id ?? snowflake('8');
  const authorId = options.authorId ?? OTHER;
  const at = options.at ?? Date.now();

  const payload: Record<string, unknown> = {
    ...recorded,
    id,
    guild_id: GUILD,
    channel_id: options.channelId ?? CHANNEL,
    timestamp: new Date(at).toISOString(),
    type: options.type ?? 0,
    author: {
      ...(recorded.author as Record<string, unknown>),
      id: authorId,
      username: options.username ?? 'author',
      global_name: options.globalName ?? null,
      bot: options.bot ?? false,
    },
    mentions: options.mentions ?? [],
  };

  if (options.member !== false) {
    payload.member = { nick: options.nick ?? null, roles: options.roles ?? rolesOf(authorId) };
  }

  if (options.webhook) payload.webhook_id = '1300000000000000001';

  return {
    id: `message.created:${id}`,
    type: 'message.created',
    guildId: GUILD,
    occurredAt: at,
    payload,
  };
}

export function messageIdOf(event: ProtonEvent): string {
  return (event.payload as { id: string }).id;
}

export interface ConfigChangedOptions {
  auditId?: string;
  moduleId?: string;
  enabledBefore?: boolean;
  enabledAfter?: boolean;
  changedKeys?: string[];
}

export function configChanged(options: ConfigChangedOptions = {}): ProtonEvent {
  const auditId = options.auditId ?? newId();

  return {
    id: `proton.config_changed:${GUILD}:${auditId}`,
    type: 'proton.config_changed',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      auditId,
      guildId: GUILD,
      moduleId: options.moduleId ?? 'afk',
      actorId: STAFF,
      source: 'dashboard',
      enabledBefore: options.enabledBefore ?? true,
      enabledAfter: options.enabledAfter ?? true,
      changedKeys: options.changedKeys ?? [],
    },
  };
}

export function memberLeft(userId: string): ProtonEvent {
  return {
    id: `member.left:${GUILD}:${userId}:1`,
    type: 'member.left',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: { guild_id: GUILD, user: { id: userId, username: 'gone' } },
  };
}
