import type { CaseQuery, CaseSearchResult } from '@proton/core';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * The wire shape of a FieldDescriptor.
 *
 * Core's `FieldDescriptor` carries `defaultValue?: unknown`, and TanStack Start
 * constrains server-function return types to serializable ones — `unknown` fails
 * that constraint. This mirrors the same data in JSON terms; the route casts back
 * to `FieldDescriptor` at the render boundary.
 */
export interface JsonFieldDescriptor {
  kind: string;
  path: string;
  label: string;
  description?: string;
  optional: boolean;
  defaultValue?: JsonValue;
  array?: boolean;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  options?: string[];
  channelTypes?: number[];
}

export interface ModuleConfigView {
  moduleId: string;
  enabled: boolean;
  config: Record<string, JsonValue>;
  schemaVersion: number;
}

export interface ModuleSummary {
  id: string;
  name: string;
  category: string;
  descriptors: JsonFieldDescriptor[];
  /** Slash command names the module registered — see the API's `/modules` route. */
  commands: string[];
}

/**
 * Server-side client for the API service.
 *
 * Server functions are a thin RPC layer (PLAN.md §9) — they authenticate,
 * authorise, then delegate here. No domain logic lives in the dashboard, so the
 * worker and the dashboard cannot drift apart on what an operation means.
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #secret: string;

  constructor(baseUrl: string, secret: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#secret = secret;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-proton-secret': this.#secret,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `api returned ${response.status}`);
    }

    return (await response.json()) as T;
  }

  listModules(guildId: string): Promise<{ modules: ModuleSummary[] }> {
    return this.#request(`/guilds/${guildId}/modules`);
  }

  getModule(guildId: string, moduleId: string): Promise<ModuleConfigView> {
    return this.#request(`/guilds/${guildId}/modules/${moduleId}`);
  }

  /**
   * `CaseSearchResult` is already JSON-safe — ISO strings, no `Date`, no
   * `unknown` — so unlike `FieldDescriptor` it needs no mirror type here.
   */
  searchCases(guildId: string, query: CaseQuery): Promise<CaseSearchResult> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }

    return this.#request(`/guilds/${guildId}/cases?${params.toString()}`);
  }

  updateModule(
    guildId: string,
    moduleId: string,
    body: {
      enabled?: boolean | undefined;
      config?: Record<string, unknown> | undefined;
      actorId: string;
      source: 'dashboard';
      ipHash?: string | undefined;
    },
  ): Promise<{ before: ModuleConfigView; after: ModuleConfigView }> {
    return this.#request(`/guilds/${guildId}/modules/${moduleId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
