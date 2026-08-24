import {
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
} from '../src/config.ts';
import type { HoneypotDeps } from '../src/deps.ts';
import { handleMessage, type TrapOutcome } from '../src/listener.ts';
import { handleNoticeRequest, type NoticeOutcome } from '../src/service.ts';
import type { HoneypotLock } from '../src/store.ts';

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

export class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

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
      return { status: 200, body: { id: `70000000000000${1000 + this.#messages}` } };
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

export interface NoticeOverrides {
  config: Partial<HoneypotConfig>;
  channelId: string;
  payload: unknown;
}

export interface Harness {
  rest: FakeRest;
  lock: MemoryHoneypotLock;
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

  embedIn(channelId: string): Record<string, unknown> | null;

  deleted(): string[];

  cases(): CaseInput[];

  said(level: CapturedLog['level']): string[];

  trip(overrides?: Partial<TripOverrides>): Promise<TrapOutcome>;

  notice(overrides?: Partial<NoticeOverrides>): Promise<NoticeOutcome>;
}

export function harness(options: { botPermissions?: bigint } = {}): Harness {
  const botPermissions = options.botPermissions ?? BOT_PERMISSIONS;

  let clock = Date.now();
  const now = (): number => clock;

  const rest = new FakeRest();
  const lock = new MemoryHoneypotLock(now);
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

  const deps: HoneypotDeps = { lock, botUserId: BOT, guildState: store, now };

  const moduleContext = (config: Partial<HoneypotConfig> = {}): ModuleContext<HoneypotConfig> => ({
    guildId: GUILD,
    config: { ...honeypotDefaultConfig, ...config },
    executor,
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

  const bodies = (method: string, path: RegExp): Array<Record<string, unknown>> =>
    rest.calls
      .filter((call) => call.method === method && path.test(call.path))
      .map((call) => (call.body ?? {}) as Record<string, unknown>);

  const sentIn = (channelId: string): Array<Record<string, unknown>> =>
    bodies('POST', new RegExp(`^/channels/${channelId}/messages$`));

  return {
    rest,
    lock,
    logs,
    published,
    memberRoles,
    deps,
    now,
    sentIn,
    advance: (ms) => {
      clock += ms;
    },

    keys: () => [...dedupe.keys],

    calls: () => rest.calls.map((call) => `${call.method} ${call.path}`),

    bodyOf: (method, path) =>
      (rest.calls.find((call) => call.method === method && call.path === path)?.body as
        | Record<string, unknown>
        | undefined) ?? null,

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

    async notice(overrides = {}) {
      const event: ProtonEvent = {
        id: `event-${newId()}`,
        type: 'honeypot.notice_requested',
        guildId: GUILD,
        occurredAt: now(),
        payload: overrides.payload ?? {
          guildId: GUILD,
          actorId: OWNER,
          channelId: overrides.channelId ?? TRAP,
        },
      };

      return handleNoticeRequest(event, moduleContext(overrides.config));
    },
  };
}
