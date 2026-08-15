import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  Logger,
  ModuleContext,
  ProtonEvent,
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
