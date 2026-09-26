import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type DedupeStore,
  DefaultActionExecutor,
  DISCORD_EPOCH_MS,
  type GuildState,
  type Logger,
  type ModuleContext,
  Permissions,
  type ProtonEvent,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { type PhishingConfig, phishingDefaultConfig } from '../src/config.ts';
import type { BlocklistInstall, BlocklistStats, BlocklistStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const CHANNEL = '500000000000000001';
export const ALERT_CHANNEL = '500000000000000009';
export const AUTHOR = '400000000000000001';
export const BOT = '300000000000000001';
export const MESSAGE = '600000000000000001';

export const BAD_DOMAIN = 'steamcommunity-gift.ru';

export const LOOKALIKE_DOMAIN = 'steamcommunity.com';

export class MemoryBlocklistStore implements BlocklistStore {
  #domains = new Set<string>();
  #stats: BlocklistStats = { size: 0, refreshedAt: null, feeds: [], failures: [] };

  failLookupWith: Error | null = null;

  readonly installs: BlocklistInstall[] = [];

  constructor(domains: readonly string[] = []) {
    this.#domains = new Set(domains);
    this.#stats = { ...this.#stats, size: this.#domains.size };
  }

  async replace(install: BlocklistInstall): Promise<number> {
    if (install.domains.length === 0) {
      throw new Error('replace was called with no domains');
    }
    this.installs.push(install);
    this.#domains = new Set(install.domains);
    this.#stats = {
      size: this.#domains.size,
      refreshedAt: install.refreshedAt,
      feeds: [...install.feeds],
      failures: install.failures.map((failure) => ({ ...failure })),
    };
    return this.#domains.size;
  }

  async lookup(candidates: readonly string[]): Promise<string | null> {
    if (this.failLookupWith) throw this.failLookupWith;
    for (const candidate of candidates) {
      if (this.#domains.has(candidate)) return candidate;
    }
    return null;
  }

  async stats(): Promise<BlocklistStats> {
    return { ...this.#stats };
  }

  get size(): number {
    return this.#domains.size;
  }
}

export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export function recordingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
  };
}

export class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  results: Partial<Record<string, ActionResult>> = {};

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.results[request.kind] ?? { status: 'executed', caseId: 'case_1' };
  }

  of(kind: string): ActionRequest | undefined {
    return this.requests.find((request) => request.kind === kind);
  }
}

export function payloadOf(request: ActionRequest | undefined): Record<string, unknown> {
  if (!request) throw new Error('expected an action request to have been recorded, but none was');
  return request.payload as Record<string, unknown>;
}

export interface Harness {
  ctx: ModuleContext<PhishingConfig>;
  executor: RecordingExecutor;
  logs: CapturedLog[];
}

export function context(config: Partial<PhishingConfig> = {}): Harness {
  const { logger, logs } = recordingLogger();
  const executor = new RecordingExecutor();

  return {
    executor,
    logs,
    ctx: {
      guildId: GUILD,
      config: { ...phishingDefaultConfig, ...config },
      executor,
      logger,
    },
  };
}

const OWNER = '200000000000000001';
const BOT_ROLE = '700000000000000001';

export class DiscordStub implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  readonly removed = new Set<string>();

  refuseRemovalWith: RestResponse | null = null;
  removeThenAnswer: RestResponse | Error | null = null;
  memberLookupFails = false;
  lookupSaysNotMember = false;

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const removal = /^\/guilds\/\d+\/(?:members|bans)\/(\d+)$/.exec(options.path);
    if (removal?.[1] && (options.method === 'DELETE' || options.method === 'PUT')) {
      if (this.refuseRemovalWith) return this.refuseRemovalWith;
      this.removed.add(removal[1]);
      if (this.removeThenAnswer instanceof Error) throw this.removeThenAnswer;
      return this.removeThenAnswer ?? { status: 204, body: undefined };
    }

    return { status: 200, body: { id: '1' } };
  }

  alerts(): string[] {
    return this.calls
      .filter(
        (call) => call.method === 'POST' && call.path === `/channels/${ALERT_CHANNEL}/messages`,
      )
      .map((call) => String((call.body as { content?: unknown }).content));
  }

  memberCalls(): RestRequestOptions[] {
    return this.calls.filter((call) => /\/(members|bans)\//.test(call.path));
  }
}

export function liveContext(config: Partial<PhishingConfig> = {}): {
  ctx: ModuleContext<PhishingConfig>;
  discord: DiscordStub;
  logs: CapturedLog[];
} {
  const discord = new DiscordStub();
  const { logger, logs } = recordingLogger();
  const claimed = new Set<string>();

  const dedupe: DedupeStore = {
    claim: async (key) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release: async (key) => {
      claimed.delete(key);
    },
    has: async (key) => claimed.has(key),
  };

  const state: GuildState = {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: Permissions.ViewChannel, position: 0 }],
      [
        BOT_ROLE,
        {
          id: BOT_ROLE,
          permissions:
            Permissions.SendMessages |
            Permissions.KickMembers |
            Permissions.BanMembers |
            Permissions.ModerateMembers,
          position: 5,
        },
      ],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }],
      [ALERT_CHANNEL, { id: ALERT_CHANNEL, parentId: null, overwrites: [] }],
    ]),
    updatedAt: Date.now(),
  };

  const executor = new DefaultActionExecutor({
    dedupe,
    rest: discord,
    recorder: { record: async () => ({ caseId: 'case_1' }) },
    resolveContext: async (request, hints) => {
      const resolved = await resolvePrecheckContext(
        {
          store: {
            get: async () => state,
            put: async () => undefined,
            patch: async () => undefined,
            delete: async () => undefined,
          },
          botUserId: BOT,
          fetchMemberRoles: async (_guildId, userId) => {
            if (discord.memberLookupFails) return null;
            if (!discord.removed.has(userId)) return [];
            return discord.lookupSaysNotMember ? 'not_member' : null;
          },
        },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  return {
    discord,
    logs,
    ctx: {
      guildId: GUILD,
      config: { ...phishingDefaultConfig, ...config },
      executor,
      logger,
    },
  };
}

export function recentMessageId(ageMs = 60_000): string {
  return String(BigInt(Date.now() - ageMs - DISCORD_EPOCH_MS) << 22n);
}

interface MessageOverrides {
  id?: string;
  content?: string;
  authorId?: string;
  channelId?: string;
  guildId?: string | null;
  type?: 'message.created' | 'message.updated';
}

export function messageEvent(overrides: MessageOverrides = {}): ProtonEvent {
  const type = overrides.type ?? 'message.created';
  const id = overrides.id ?? MESSAGE;

  return {
    id: `${type}:${id}`,
    type,
    guildId: overrides.guildId === undefined ? GUILD : overrides.guildId,
    occurredAt: Date.parse('2026-08-15T10:00:00.000Z'),
    payload: {
      id,
      channel_id: overrides.channelId ?? CHANNEL,
      guild_id: GUILD,
      author: { id: overrides.authorId ?? AUTHOR, bot: false },
      content: overrides.content ?? 'hello',
    },
  };
}

export function stubFetch(
  routes: Record<string, string | Error | { status: number; body?: string }>,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];

    if (route === undefined) throw new Error(`no stub for ${url}`);
    if (route instanceof Error) throw route;

    if (typeof route === 'string') {
      return new Response(route, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response(route.body ?? '', { status: route.status });
  }) as typeof globalThis.fetch;
}
