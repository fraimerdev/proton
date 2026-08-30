import type {
  AppealLinkClaims,
  BlockedMemberList,
  BlockedMemberQuery,
  CaseQuery,
  CaseSearchResult,
  GuildOverview,
  GuildPresence,
  LeaderboardQuery,
  LeaderboardResult,
  LiftBlockResult,
  ModuleConfigView,
  ModuleIndex,
  ModuleUpdateResult,
  VerificationRequestResult,
} from '@proton/core';
import {
  blockedMemberListSchema,
  botInviteSchema,
  guildOverviewSchema,
  guildPresenceSchema,
  liftBlockResultSchema,
  moduleConfigViewSchema,
  moduleIndexSchema,
  moduleUpdateResultSchema,
  verificationRequestResultSchema,
} from '@proton/core';
import type { TagQuery, TagSearchResult } from '@proton/module-tags/query';
import type { TicketQuery, TicketSearchResult } from '@proton/module-tickets/query';
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

      // Neutral about reads and writes, because the callers supply that half ("Could not save: …").
      // A gateway error or an HTML error page used to reach the admin as "api returned 502".
      throw new Error(
        body.message ??
          `Proton's API did not answer (HTTP ${response.status}). Nothing was changed — try again, ` +
            `and if it keeps happening the API is the part that is down, not Discord.`,
      );
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

  async invitePermissions(): Promise<string> {
    const { permissions } = await this.#parsed('/invite', botInviteSchema);

    return permissions;
  }

  guildPresence(guildIds: readonly string[]): Promise<GuildPresence> {
    return this.#parsed('/guilds/presence', guildPresenceSchema, {
      method: 'POST',
      body: JSON.stringify({ ids: guildIds }),
    });
  }

  listModules(guildId: string): Promise<ModuleIndex> {
    return this.#parsed(`/guilds/${guildId}/modules`, moduleIndexSchema);
  }

  getModule(guildId: string, moduleId: string): Promise<ModuleConfigView> {
    return this.#parsed(`/guilds/${guildId}/modules/${moduleId}`, moduleConfigViewSchema);
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

  getAppealForm(claims: AppealLinkClaims): Promise<{ guildId: string; view: unknown }> {
    return this.#request(`/guilds/${claims.guildId}/appeals/form`, {
      method: 'POST',
      body: JSON.stringify({ claims }),
    });
  }

  submitAppeal(
    claims: AppealLinkClaims,
    answers: Record<string, string>,
  ): Promise<{ number: number; requestId: string }> {
    return this.#request(`/guilds/${claims.guildId}/appeals/submit`, {
      method: 'POST',
      body: JSON.stringify({ claims, answers }),
    });
  }

  searchBlockedMembers(guildId: string, query: BlockedMemberQuery): Promise<BlockedMemberList> {
    return this.#parsed(
      `/guilds/${guildId}/blocked-members?${queryString(query)}`,
      blockedMemberListSchema,
    );
  }

  liftBlockedMember(
    guildId: string,
    userId: string,
    body: { actorId: string; source: string; liftReason: string; ipHash?: string | undefined },
  ): Promise<LiftBlockResult> {
    return this.#parsed(
      `/guilds/${guildId}/blocked-members/${userId}/lift`,
      liftBlockResultSchema,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  searchTags(guildId: string, query: TagQuery): Promise<TagSearchResult> {
    return this.#request(`/guilds/${guildId}/tags?${queryString(query)}`);
  }

  searchTickets(guildId: string, query: TicketQuery): Promise<TicketSearchResult> {
    return this.#request(`/guilds/${guildId}/tickets?${queryString(query)}`);
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

  brandingAsset(guildId: string, kind: string): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/branding/${kind}`, {
      headers: { 'x-proton-secret': this.#secret },
    });
  }

  uploadBrandingAsset(
    guildId: string,
    kind: string,
    bytes: ArrayBuffer,
    actorId: string,
  ): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/branding/${kind}`, {
      method: 'PUT',
      headers: {
        'x-proton-secret': this.#secret,
        'x-proton-actor': actorId,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    });
  }

  clearBrandingAsset(guildId: string, kind: string, actorId: string): Promise<Response> {
    return fetch(`${this.#baseUrl}/guilds/${guildId}/branding/${kind}`, {
      method: 'DELETE',
      headers: { 'x-proton-secret': this.#secret, 'x-proton-actor': actorId },
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
