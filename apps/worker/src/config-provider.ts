import type { ConfigProvider, ModuleConfigSnapshot } from './runtime.ts';

export class ConfigUnavailableError extends Error {
  readonly permanent: boolean;
  readonly status: number | undefined;
  readonly guildId: string;
  readonly moduleId: string;

  constructor(init: {
    message: string;
    permanent: boolean;
    guildId: string;
    moduleId: string;
    status?: number;
  }) {
    super(init.message);
    this.name = 'ConfigUnavailableError';
    this.permanent = init.permanent;
    this.status = init.status;
    this.guildId = init.guildId;
    this.moduleId = init.moduleId;
  }
}

const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 404]);

export class HttpConfigProvider implements ConfigProvider {
  readonly #baseUrl: string;
  readonly #secret: string;

  constructor(baseUrl: string, secret: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#secret = secret;
  }

  async get(guildId: string, moduleId: string): Promise<ModuleConfigSnapshot> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/guilds/${guildId}/modules/${moduleId}`, {
        headers: { 'x-proton-secret': this.#secret },
      });
    } catch (error) {
      throw new ConfigUnavailableError({
        message: `could not reach the API for ${moduleId} in ${guildId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        permanent: false,
        guildId,
        moduleId,
      });
    }

    if (!response.ok) {
      throw new ConfigUnavailableError({
        message: `api returned ${response.status} for ${moduleId} in ${guildId}`,
        permanent: PERMANENT_STATUSES.has(response.status),
        status: response.status,
        guildId,
        moduleId,
      });
    }

    const body = (await response.json()) as { enabled: boolean; config: unknown };
    return { enabled: body.enabled, config: body.config };
  }
}

interface CacheEntry {
  value: ModuleConfigSnapshot;
  expiresAt: number;
}

export interface CachingConfigProviderOptions {
  ttlMs: number;
  now?(): number;
}

export class CachingConfigProvider implements ConfigProvider {
  readonly #inner: ConfigProvider;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<ModuleConfigSnapshot>>();

  constructor(inner: ConfigProvider, options: CachingConfigProviderOptions) {
    this.#inner = inner;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? (() => Date.now());
  }

  async get(guildId: string, moduleId: string): Promise<ModuleConfigSnapshot> {
    const key = `${guildId}:${moduleId}`;

    const cached = this.#entries.get(key);
    if (cached) {
      if (cached.expiresAt > this.#now()) return cached.value;

      this.#entries.delete(key);
    }

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const promise = this.#inner
      .get(guildId, moduleId)
      .then((value) => {
        if (this.#ttlMs > 0) {
          this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
        }
        return value;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });

    this.#inflight.set(key, promise);
    return promise;
  }

  invalidate(guildId?: string, moduleId?: string): void {
    if (guildId === undefined || moduleId === undefined) {
      this.#entries.clear();
      return;
    }
    this.#entries.delete(`${guildId}:${moduleId}`);
  }
}
