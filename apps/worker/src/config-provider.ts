import type { ConfigProvider, ModuleConfigSnapshot } from './runtime.ts';

/**
 * A module's config could not be read, and whether trying again could help.
 *
 * The distinction is the whole point of the type. On the command path a failed
 * read costs one unanswered interaction; on the listener path the handler throws,
 * the bus leaves the entry unacked, and it is redelivered every `claimIdleMs`
 * until it dead-letters. For a 500 or a dropped connection that is exactly right.
 * For a 400 — which `apps/api` returns when a guild's stored JSONB no longer
 * satisfies the module's schema — it is a slow-motion outage: one bad row would
 * burn every delivery and then dead-letter that guild's events for that module
 * permanently, with nothing in the logs naming the guild.
 */
export class ConfigUnavailableError extends Error {
  /** True when retrying cannot succeed: the request itself is the problem. */
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

/**
 * The only statuses that mean "this request is wrong and always will be".
 *
 * A whitelist, not `4xx`, and the difference is not academic. `apps/api` answers
 * **401** from its shared-secret middleware, so a rotated or mistyped
 * `API_SHARED_SECRET` under a `4xx = permanent` rule would have the listener
 * runtime ack and discard every event, for every module, in every guild — a
 * total silent outage that never retries and never recovers, with the events
 * gone even after the secret is fixed. 429 and 408 are equally retryable, and an
 * ingress in front of the API can produce either.
 *
 * So only the two the API raises *about the module itself* are permanent: 404
 * for a module it does not know, and 400 for a stored config that no longer
 * satisfies its schema. Both say the same thing on every retry.
 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/**
 * Reads module config from the API service rather than the database.
 *
 * PLAN.md §9: the worker and the dashboard must share one definition of every
 * domain operation. Querying Postgres directly here would duplicate validation
 * and `schema_version` migration, and the two copies would drift.
 */
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
      // The API is down, restarting or unreachable. Always worth retrying.
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
  /** How long a snapshot may be reused. 0 disables caching, which tests want. */
  ttlMs: number;
  now?(): number;
}

/**
 * A short-lived read-through cache in front of another provider.
 *
 * Not an optimisation — a precondition for listener dispatch. `ModuleRuntime`
 * reads config once per slash command, which is rare enough that an uncached
 * HTTP round trip per read is free. A listener reads config once per *event*:
 * phishing runs on every `message.created` in every guild that enabled it, and
 * anti-raid runs on every join, which during a raid is the load. Uncached, the
 * defence becomes the load generator, and each of those reads is an HTTP hop, a
 * Postgres SELECT and a Zod parse.
 *
 * Two behaviours beyond a plain TTL map, both load-bearing:
 *
 *  - **Single-flight.** Concurrent reads for the same `(guild, module)` share one
 *    in-flight promise. A twenty-deletion burst arriving together is one fetch,
 *    not twenty, which is precisely the shape of traffic that matters here.
 *  - **Negative results are cached too.** A module a guild has *not* enabled is
 *    the overwhelmingly common case, and it must not cost a round trip per
 *    message. Errors, by contrast, are never cached: a 500 that stuck for the
 *    TTL would outlive the outage that caused it.
 *
 * Invalidation is deliberately TTL-only. `apps/api` is the sole writer, so the
 * honest long-term answer is a config-changed event on the bus; until then the
 * TTL bounds how long a dashboard toggle takes to reach the worker, and it is
 * set low enough (seconds) that nobody watching the dashboard notices.
 */
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
      // Expired entries are deleted on sight, not merely ignored. A worker
      // serving thousands of guilds would otherwise hold one entry per
      // (guild, module) for the life of the process — a map that only ever
      // grows, holding values it will never return.
      this.#entries.delete(key);
    }

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const promise = this.#inner
      .get(guildId, moduleId)
      .then((value) => {
        // A zero TTL means "never serve from cache", so do not store one —
        // otherwise a test that pinned the clock would read it back forever.
        if (this.#ttlMs > 0) {
          this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
        }
        return value;
      })
      .finally(() => {
        // Cleared on both paths: a rejection must not be remembered, and the
        // next caller has to be free to try again immediately.
        this.#inflight.delete(key);
      });

    this.#inflight.set(key, promise);
    return promise;
  }

  /** Drop a cached snapshot, or the whole cache when no key is given. */
  invalidate(guildId?: string, moduleId?: string): void {
    if (guildId === undefined || moduleId === undefined) {
      this.#entries.clear();
      return;
    }
    this.#entries.delete(`${guildId}:${moduleId}`);
  }
}
