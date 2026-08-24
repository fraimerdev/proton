import type {
  CaseQuery,
  CaseSearchResult,
  GuildOverview,
  LeaderboardQuery,
  LeaderboardResult,
  ModuleConfigView,
  ModuleDescriptors,
  ModuleIndex,
  ModuleUpdateResult,
  VerificationRequestResult,
} from '@proton/core';
import {
  guildOverviewSchema,
  guildPresenceSchema,
  moduleConfigViewSchema,
  moduleDescriptorsSchema,
  moduleIndexSchema,
  moduleUpdateResultSchema,
  verificationRequestResultSchema,
} from '@proton/core';
import type { TagQuery, TagSearchResult } from '@proton/module-tags/query';
import type { z } from 'zod';
import type { AuditStamp } from '../server/audit.ts';

function queryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }

  return params.toString();
}

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

  // Parsed rather than cast, for the shapes both apps declare: the dashboard's own copy of
  // ModuleConfigView had already drifted two fields behind the api's before this existed, and a
  // cast turns that into a runtime undefined somewhere far from the endpoint that changed.
  async #parsed<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init: RequestInit = {},
  ): Promise<z.output<TSchema>> {
    const parsed = schema.safeParse(await this.#request(path, init));

    if (!parsed.success) {
      throw new Error(
        `the api answered ${path} with a shape this dashboard does not understand — ` +
          `${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`,
      );
    }

    return parsed.data;
  }

  getGuild(guildId: string): Promise<GuildOverview> {
    return this.#parsed(`/guilds/${guildId}`, guildOverviewSchema);
  }

  async guildPresence(guildIds: readonly string[]): Promise<string[]> {
    const { present } = await this.#parsed('/guilds/presence', guildPresenceSchema, {
      method: 'POST',
      body: JSON.stringify({ ids: guildIds }),
    });

    return present;
  }

  listModules(guildId: string): Promise<ModuleIndex> {
    return this.#parsed(`/guilds/${guildId}/modules`, moduleIndexSchema);
  }

  getModule(guildId: string, moduleId: string): Promise<ModuleConfigView> {
    return this.#parsed(`/guilds/${guildId}/modules/${moduleId}`, moduleConfigViewSchema);
  }

  getModuleDescriptors(guildId: string, moduleId: string): Promise<ModuleDescriptors> {
    return this.#parsed(
      `/guilds/${guildId}/modules/${moduleId}/descriptors`,
      moduleDescriptorsSchema,
    );
  }

  recordVerificationPass(
    guildId: string,
    body: { userId: string; jti: string },
  ): Promise<VerificationRequestResult> {
    return this.#parsed(`/guilds/${guildId}/verification/passed`, verificationRequestResultSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  searchCases(guildId: string, query: CaseQuery): Promise<CaseSearchResult> {
    return this.#request(`/guilds/${guildId}/cases?${queryString(query)}`);
  }

  searchTags(guildId: string, query: TagQuery): Promise<TagSearchResult> {
    return this.#request(`/guilds/${guildId}/tags?${queryString(query)}`);
  }

  searchLeaderboard(guildId: string, query: LeaderboardQuery): Promise<LeaderboardResult> {
    return this.#request(`/guilds/${guildId}/leaderboard?${queryString(query)}`);
  }

  // The Response itself, not bytes: the card is an image the browser streams into an <img>, and
  // buffering it here to hand back a data URI would cost a base64 round trip per keystroke.
  cardPreview(guildId: string, query: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/cards/preview?${queryString(query)}`, {
      headers: { 'x-proton-secret': this.#secret },
    });
  }

  updateModule(
    guildId: string,
    moduleId: string,
    body: AuditStamp & {
      enabled?: boolean | undefined;
      config?: Record<string, unknown> | undefined;
    },
  ): Promise<ModuleUpdateResult> {
    return this.#parsed(`/guilds/${guildId}/modules/${moduleId}`, moduleUpdateResultSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
