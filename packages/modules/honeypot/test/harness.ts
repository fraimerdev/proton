import {
  type ActionExecutor,
  type ActionRequest,
  type CaseInput,
  type CaseRecorder,
  type ChannelState,
  type DedupeStore,
  DefaultActionExecutor,
  type EventType,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import {
  type HoneypotChannel,
  type HoneypotConfig,
  honeypotChannelSchema,
  honeypotDefaultConfig,
  MODULE_ID,
} from '../src/config.ts';
import type { HoneypotDeps } from '../src/deps.ts';
import { handleStatsPress, type StatsOutcome } from '../src/interactions.ts';
import { handleMessage, type TrapOutcome } from '../src/listener.ts';
import { type NoticeOutcome, reconcileNotices } from '../src/service.ts';
import {
  type CaughtInput,
  type HoneypotLock,
  type HoneypotStats,
  type HoneypotStatsStore,
  type NoticeBook,
  type NoticeStore,
  noticeBookSchema,
  RECENT_SHOWN,
} from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';

export const MEMBER = '400000000000000001';

export const ABOVE = '400000000000000002';

export const OTHER = '400000000000000003';

export const TRAP = '500000000000000001';

export const THREAD = '500000000000000002';

export const LOUNGE = '500000000000000003';

export const LOG = '500000000000000004';

export const MESSAGE = '1400000000000000001';

export const NOTICE = '700000000000009002';

export const INTERACTION = '600000000000000001';

export const APPLICATION = '300000000000000009';

export const INTERACTION_TOKEN = 'interaction-token';

export const MOD_PERMISSIONS = String(Permissions.BanMembers);

export const MANAGER_PERMISSIONS = String(Permissions.ManageGuild);

export const PLAIN_PERMISSIONS = String(
  Permissions.ViewChannel | Permissions.SendMessages | Permissions.AddReactions,
);

export const EVERYONE_ROLE = GUILD;
export const LOW_ROLE = '410000000000000001';
export const BOT_ROLE = '410000000000000002';
export const ABOVE_BOT_ROLE = '410000000000000009';

export const JOIN_MESSAGE_TYPE = 7;

export const BOOST_MESSAGE_TYPE = 8;

const POSITIONS: Record<string, number> = {
  [EVERYONE_ROLE]: 0,
  [LOW_ROLE]: 1,
  [BOT_ROLE]: 5,
  [ABOVE_BOT_ROLE]: 9,
};

export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.SendMessagesInThreads |
  Permissions.EmbedLinks |
  Permissions.ManageMessages |
  Permissions.BanMembers |
  Permissions.KickMembers |
  Permissions.ModerateMembers;

const CHANNELS: ChannelState[] = [
  { id: TRAP, parentId: null, type: 0, overwrites: [] },
  { id: THREAD, parentId: TRAP, type: 11, overwrites: [] },
  { id: LOUNGE, parentId: null, type: 0, overwrites: [] },
  { id: LOG, parentId: null, type: 0, overwrites: [] },
];

export function trap(overrides: Partial<HoneypotChannel> = {}): HoneypotChannel {
  return honeypotChannelSchema.parse({ channelId: TRAP, ...overrides });
}

export function armed(overrides: Partial<HoneypotChannel> = {}): Partial<HoneypotConfig> {
  return { enabled: true, channels: [trap(overrides)] };
}

class MemoryDedupe implements DedupeStore {
  readonly keys: string[] = [];
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    this.keys.push(key);
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

export class MemoryHoneypotLock implements HoneypotLock {
  readonly attempts: Array<{ guildId: string; userId: string; ttlMs: number }> = [];

  readonly #held = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  async claim(guildId: string, userId: string, ttlMs: number): Promise<boolean> {
    this.attempts.push({ guildId, userId, ttlMs });

    const key = `${guildId}:${userId}`;
    const held = this.#held.get(key);
    if (held !== undefined && held > this.#now()) return false;

    this.#held.set(key, this.#now() + ttlMs);
    return true;
  }
}

export class MemoryNoticeStore implements NoticeStore {
  readonly writes: NoticeBook[] = [];

  readonly #books = new Map<string, NoticeBook>();

  seed(guildId: string, book: NoticeBook): void {
    this.#books.set(guildId, noticeBookSchema.parse(book));
  }

  read(guildId: string): NoticeBook {
    return { ...(this.#books.get(guildId) ?? {}) };
  }

  async get(guildId: string): Promise<NoticeBook> {
    return this.read(guildId);
  }

  async put(guildId: string, book: NoticeBook): Promise<void> {
    const stored = noticeBookSchema.parse(book);

    this.#books.set(guildId, stored);
    this.writes.push(stored);
  }
}

export class MemoryStatsStore implements HoneypotStatsStore {
  readonly entries: Array<{
    guildId: string;
    channelId: string;
    messageId: string;
    entry: CaughtInput;
  }> = [];

  readonly claims: Array<{ guildId: string; channelId: string; ttlMs: number }> = [];

  // Forces every refresh to lose its lease without a test having to wait a window out.
  refuse = false;

  readonly #leases = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  seed(guildId: string, channelId: string, entries: readonly CaughtInput[]): void {
    for (const entry of entries) {
      this.entries.push({ guildId, channelId, messageId: entry.messageId, entry });
    }
  }

  caught(guildId: string, channelId: string): CaughtInput[] {
    return this.entries
      .filter((held) => held.guildId === guildId && held.channelId === channelId)
      .map((held) => held.entry);
  }

  async record(guildId: string, channelId: string, entry: CaughtInput): Promise<number> {
    const already = this.entries.some(
      (held) =>
        held.guildId === guildId &&
        held.channelId === channelId &&
        held.messageId === entry.messageId,
    );

    if (!already) this.entries.push({ guildId, channelId, messageId: entry.messageId, entry });

    return this.caught(guildId, channelId).length;
  }

  async total(guildId: string, channelId: string): Promise<number> {
    return this.caught(guildId, channelId).length;
  }

  async read(guildId: string, channelId: string, now: number): Promise<HoneypotStats> {
    const caught = this.caught(guildId, channelId);

    const byAction: Record<string, number> = {};
    for (const entry of caught) byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;

    const within = (ms: number): number => caught.filter((entry) => entry.at >= now - ms).length;

    return {
      total: caught.length,
      lastDay: within(24 * 60 * 60 * 1000),
      lastWeek: within(7 * 24 * 60 * 60 * 1000),
      byAction,
      recent: [...caught].sort((a, b) => b.at - a.at).slice(0, RECENT_SHOWN),
    };
  }

  async claimRefresh(guildId: string, channelId: string, ttlMs: number): Promise<boolean> {
    this.claims.push({ guildId, channelId, ttlMs });
    if (this.refuse) return false;

    const key = `${guildId}:${channelId}`;
    const held = this.#leases.get(key);
    if (held !== undefined && held > this.#now()) return false;

    this.#leases.set(key, this.#now() + ttlMs);
    return true;
  }
}

export class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  readonly posted: string[] = [];

  readonly refusals: Array<{
    match(call: RestRequestOptions): boolean;
    response: RestResponse;
  }> = [];

  #messages = 0;

  fail(match: (call: RestRequestOptions) => boolean, response: RestResponse): void {
    this.refusals.push({ match, response });
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const refusal = this.refusals.find((candidate) => candidate.match(options));
    if (refusal) return refusal.response;

    if (options.method === 'POST' && /^\/channels\/\d+\/messages$/.test(options.path)) {
      this.#messages += 1;

      const id = `70000000000000${1000 + this.#messages}`;
      this.posted.push(id);

      return { status: 200, body: { id } };
    }

    return { status: 204, body: {} };
  }
}

export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface PublishedEvent {
  type: EventType;
  naturalKey: string;
  payload: unknown;
}

export interface TripOverrides {
  config: Partial<HoneypotConfig>;

  channelId: string;
  authorId: string;
  messageId: string;

  type: number;
  bot: boolean;
  webhookId: string;

  payload: Record<string, unknown>;
}

export interface SaveOverrides {
  config: Partial<HoneypotConfig>;

  moduleId: string;
  enabledAfter: boolean;
  changedKeys: string[];
  auditId: string;
}

export interface PressOverrides {
  config: Partial<HoneypotConfig>;

  userId: string;

  // The bitfield Discord puts on the interaction's member, which is what the privilege gate reads.
  permissions: string;

  channelId: string;
  interactionId: string;
  eventId: string;
}

export interface Harness {
  rest: FakeRest;
  lock: MemoryHoneypotLock;
  notices: MemoryNoticeStore;
  stats: MemoryStatsStore;
  logs: CapturedLog[];
  published: PublishedEvent[];
  memberRoles: Map<string, Set<string>>;
  deps: HoneypotDeps;

  now(): number;
  advance(ms: number): void;

  keys(): string[];

  calls(): string[];

  bodyOf(method: string, path: string): Record<string, unknown> | null;

  sentIn(channelId: string): Array<Record<string, unknown>>;

  editedIn(channelId: string): Array<Record<string, unknown>>;

  componentsIn(channelId: string): Array<Record<string, unknown>>;

  embedIn(channelId: string): Record<string, unknown> | null;

  requests(): ActionRequest[];

  replies(): Array<Record<string, unknown>>;

  replied(): Record<string, unknown> | null;

  repliedComponents(): Array<Record<string, unknown>>;

  deleted(): string[];

  cases(): CaseInput[];

  said(level: CapturedLog['level']): string[];

  remembered(): NoticeBook;

  trip(overrides?: Partial<TripOverrides>): Promise<TrapOutcome>;

  saved(overrides?: Partial<SaveOverrides>): Promise<NoticeOutcome>;

  press(customId: string, overrides?: Partial<PressOverrides>): Promise<StatsOutcome>;
}

export function harness(
  options: { botPermissions?: bigint; notices?: boolean; stats?: boolean } = {},
): Harness {
  const botPermissions = options.botPermissions ?? BOT_PERMISSIONS;

  let clock = Date.now();
  const now = (): number => clock;

  const rest = new FakeRest();
  const lock = new MemoryHoneypotLock(now);
  const notices = new MemoryNoticeStore();
  const stats = new MemoryStatsStore(now);
  const dedupe = new MemoryDedupe();
  const recorder = new MemoryRecorder();
  const logs: CapturedLog[] = [];
  const published: PublishedEvent[] = [];

  const memberRoles = new Map<string, Set<string>>([
    [MEMBER, new Set([EVERYONE_ROLE, LOW_ROLE])],
    [OTHER, new Set([EVERYONE_ROLE, LOW_ROLE])],
    [ABOVE, new Set([EVERYONE_ROLE, ABOVE_BOT_ROLE])],
    [BOT, new Set([BOT_ROLE])],
  ]);

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const roles = (): Map<string, GuildRole> =>
    new Map(
      Object.entries(POSITIONS).map(([id, position]) => [
        id,
        { id, permissions: id === BOT_ROLE ? botPermissions : 0n, position },
      ]),
    );

  const guildState = (): GuildState => ({
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: roles(),
    botRoleIds: [BOT_ROLE],
    channels: new Map(CHANNELS.map((channel) => [channel.id, channel])),
    updatedAt: now(),
  });

  const store: GuildStateStore = {
    get: async () => guildState(),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const fetchMemberRoles = async (_guildId: string, userId: string): Promise<string[] | null> => {
    const held = memberRoles.get(userId);
    return held ? [...held] : null;
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
        { store, botUserId: BOT, fetchMemberRoles },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const requests: ActionRequest[] = [];

  const recording: ActionExecutor = {
    execute: async (request) => {
      requests.push(request);
      return executor.execute(request);
    },
  };

  const deps: HoneypotDeps = {
    lock,
    botUserId: BOT,
    guildState: store,
    now,
    ...(options.notices === false ? {} : { notices }),
    ...(options.stats === false ? {} : { stats }),
  };

  const moduleContext = (config: Partial<HoneypotConfig> = {}): ModuleContext<HoneypotConfig> => ({
    guildId: GUILD,
    config: { ...honeypotDefaultConfig, ...config },
    executor: recording,
    logger,
    publish: async (type, naturalKey, payload) => {
      published.push({ type, naturalKey, payload });
    },
  });

  const messagePayload = (overrides: Partial<TripOverrides>): Record<string, unknown> => ({
    id: overrides.messageId ?? MESSAGE,
    channel_id: overrides.channelId ?? TRAP,
    guild_id: GUILD,
    content: 'hello',
    timestamp: '2026-08-14T09:01:00.000000+00:00',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: overrides.type ?? 0,
    flags: 0,
    author: {
      id: overrides.authorId ?? MEMBER,
      username: 'tester',
      discriminator: '0',
      global_name: 'Tester',
      avatar: null,
      bot: overrides.bot ?? false,
    },
    ...(overrides.webhookId ? { webhook_id: overrides.webhookId } : {}),
  });

  const pressPayload = (
    customId: string,
    overrides: Partial<PressOverrides>,
  ): Record<string, unknown> => {
    const channelId = overrides.channelId ?? TRAP;

    return {
      id: overrides.interactionId ?? INTERACTION,
      application_id: APPLICATION,
      type: 3,
      token: INTERACTION_TOKEN,
      guild_id: GUILD,
      channel_id: channelId,
      channel: { id: channelId, type: 0 },
      member: {
        user: { id: overrides.userId ?? MEMBER, username: 'presser', avatar: null, bot: false },
        roles: [LOW_ROLE],
        permissions: overrides.permissions ?? PLAIN_PERMISSIONS,
        joined_at: '2026-08-15T12:00:00.000000+00:00',
      },
      app_permissions: String(botPermissions),
      message: { id: NOTICE, channel_id: channelId },
      data: { custom_id: customId, component_type: 2 },
    };
  };

  const bodies = (method: string, path: RegExp): Array<Record<string, unknown>> =>
    rest.calls
      .filter((call) => call.method === method && path.test(call.path))
      .map((call) => (call.body ?? {}) as Record<string, unknown>);

  const sentIn = (channelId: string): Array<Record<string, unknown>> =>
    bodies('POST', new RegExp(`^/channels/${channelId}/messages$`));

  const editedIn = (channelId: string): Array<Record<string, unknown>> =>
    bodies('PATCH', new RegExp(`^/channels/${channelId}/messages/\\d+$`));

  const writtenIn = (channelId: string): Array<Record<string, unknown>> => {
    const edit = new RegExp(`^/channels/${channelId}/messages/\\d+$`);

    return rest.calls
      .filter(
        (call) =>
          (call.method === 'POST' && call.path === `/channels/${channelId}/messages`) ||
          (call.method === 'PATCH' && edit.test(call.path)),
      )
      .map((call) => (call.body ?? {}) as Record<string, unknown>);
  };

  const componentsOf = (body: Record<string, unknown> | undefined): Record<string, unknown>[] =>
    Array.isArray(body?.components) ? (body.components as Record<string, unknown>[]) : [];

  const replies = (): Array<Record<string, unknown>> =>
    rest.calls
      .filter((call) => call.method === 'POST' && call.path.startsWith('/interactions/'))
      .map((call) => (call.body ?? {}) as Record<string, unknown>);

  const replied = (): Record<string, unknown> | null =>
    (replies().at(-1)?.data as Record<string, unknown> | undefined) ?? null;

  let saves = 0;

  return {
    rest,
    lock,
    notices,
    stats,
    logs,
    published,
    memberRoles,
    deps,
    now,
    sentIn,
    editedIn,
    replies,
    replied,
    advance: (ms) => {
      clock += ms;
    },

    keys: () => [...dedupe.keys],

    calls: () => rest.calls.map((call) => `${call.method} ${call.path}`),

    bodyOf: (method, path) =>
      (rest.calls.find((call) => call.method === method && call.path === path)?.body as
        | Record<string, unknown>
        | undefined) ?? null,

    componentsIn: (channelId) => componentsOf(writtenIn(channelId).at(-1)),

    repliedComponents: () => componentsOf(replied() ?? undefined),

    requests: () => [...requests],

    embedIn: (channelId) => {
      const embeds = sentIn(channelId).at(-1)?.embeds;
      return Array.isArray(embeds) ? ((embeds[0] as Record<string, unknown>) ?? null) : null;
    },

    deleted: () =>
      rest.calls
        .filter(
          (call) => call.method === 'DELETE' && /^\/channels\/\d+\/messages\/\d+$/.test(call.path),
        )
        .map((call) => call.path.replace('/channels/', '').replace('/messages/', '/')),

    cases: () => recorder.recorded,

    said: (level) => logs.filter((entry) => entry.level === level).map((entry) => entry.message),

    remembered: () => notices.read(GUILD),

    async trip(overrides = {}) {
      const messageId = overrides.messageId ?? MESSAGE;

      const event: ProtonEvent = {
        id: `message.created:${messageId}`,
        type: 'message.created',
        guildId: GUILD,
        occurredAt: now(),
        payload: overrides.payload ?? messagePayload(overrides),
      };

      return handleMessage(event, moduleContext(overrides.config), deps);
    },

    async saved(overrides = {}) {
      saves += 1;
      const auditId = overrides.auditId ?? `audit-${saves}`;

      const event: ProtonEvent = {
        id: `proton.config_changed:${GUILD}:${auditId}`,
        type: 'proton.config_changed',
        guildId: GUILD,
        occurredAt: now(),
        payload: {
          auditId,
          guildId: GUILD,
          moduleId: overrides.moduleId ?? MODULE_ID,
          moduleName: 'Honeypot',
          actorId: OWNER,
          source: 'dashboard',
          enabledBefore: true,
          enabledAfter: overrides.enabledAfter ?? true,
          changedKeys: overrides.changedKeys ?? ['channels'],
        },
      };

      return reconcileNotices(event, moduleContext(overrides.config), deps);
    },

    async press(customId, overrides = {}) {
      const interactionId = overrides.interactionId ?? INTERACTION;

      const event: ProtonEvent = {
        id: overrides.eventId ?? `interaction.component:${interactionId}`,
        type: 'interaction.component',
        guildId: GUILD,
        occurredAt: now(),
        payload: pressPayload(customId, { ...overrides, interactionId }),
      };

      return handleStatsPress(event, moduleContext(overrides.config), deps);
    },
  };
}
