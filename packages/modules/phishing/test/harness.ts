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

/** A domain the fixtures treat as genuinely listed. */
export const BAD_DOMAIN = 'steamcommunity-gift.ru';

/**
 * The legitimate site the bad one impersonates.
 *
 * The pair exists so every false-positive test is about a domain a real server
 * really does link, rather than an invented string that no matcher would confuse.
 */
export const LOOKALIKE_DOMAIN = 'steamcommunity.com';

/**
 * An in-memory blocklist with the same matching contract as the Redis one:
 * exact set membership over pre-computed candidates, no substring logic. A
 * memory store that matched more loosely would let a false-positive test pass
 * here and fail against Redis.
 */
export class MemoryBlocklistStore implements BlocklistStore {
  #domains = new Set<string>();
  #stats: BlocklistStats = { size: 0, refreshedAt: null, feeds: [], failures: [] };

  /** Set when `lookup` should behave as an unreachable cache. */
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
  /** Keyed by `ActionKind`; anything unset resolves as executed. */
  results: Partial<Record<string, ActionResult>> = {};

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.results[request.kind] ?? { status: 'executed', caseId: 'case_1' };
  }

  of(kind: string): ActionRequest | undefined {
    return this.requests.find((request) => request.kind === kind);
  }
}

/**
 * The payload of a request that must exist.
 *
 * Throwing with a readable message beats an optional chain that yields
 * `undefined` and fails three assertions later on something unrelated.
 */
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

/** The gateway hands listeners the raw Discord message object verbatim. */
export function messageEvent(overrides: MessageOverrides = {}): ProtonEvent {
  const type = overrides.type ?? 'message.created';
  const id = overrides.id ?? MESSAGE;

  return {
    // Same derivation the gateway uses, so a redelivery test reuses the id.
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

/**
 * A `fetch` that serves canned responses per URL.
 *
 * Tests never touch the network (§11). A URL mapped to an `Error` rejects, which
 * is how a DNS failure or a connection reset reaches `fetchBlocklist`.
 */
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
