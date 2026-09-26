import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import type { RestProxyClient } from '../actions/rest-client.ts';
import type { EntitlementTier } from '../rules/facts.ts';
import {
  absentMemberContext,
  type MemberContextLoader,
  memberContextFromGuildMember,
} from './member-context.ts';
import type { MemberContext } from './types.ts';

export interface MemberLoaderOptions {
  now?: () => Date;
  tierOf?: (guildId: string) => Promise<EntitlementTier> | EntitlementTier;

  onUnavailable?: (guildId: string, detail: string, status?: number) => void;
}

// Discord caps a member page at 1000 (GET /guilds/{id}/members ?limit=1-1000 &after).
export const MEMBER_PAGE_MAX = 1000;

async function tierFor(guildId: string, options: MemberLoaderOptions): Promise<EntitlementTier> {
  return options.tierOf ? await options.tierOf(guildId) : 'free';
}

const discordErrorSchema = z.looseObject({ code: z.number().int().optional() });

function listFailure(status: number, body: unknown): string {
  if (status < 400) return `the REST proxy answered ${status} without a member list`;
  if (status >= 500) return `the REST proxy answered ${status} listing members`;

  const parsed = discordErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;

  if (code === RESTJSONErrorCodes.MissingAccess) {
    return (
      `Discord refused to list members (${status}, code ${code}): the Server Members privileged ` +
      'intent is off for this application (Bot → Privileged Gateway Intents in the developer ' +
      'portal), or Proton is no longer in the server'
    );
  }

  if (code === RESTJSONErrorCodes.UnknownGuild) {
    return (
      `Discord refused to list members (${status}, code ${code}): the server no longer exists ` +
      'or Proton is no longer in it'
    );
  }

  return code === undefined
    ? `Discord refused to list members (${status}) and sent no Discord error code with it`
    : `Discord refused to list members (${status}, code ${code})`;
}

export class RestMemberContextLoader implements MemberContextLoader {
  readonly #rest: RestProxyClient;
  readonly #options: MemberLoaderOptions;

  constructor(rest: RestProxyClient, options: MemberLoaderOptions = {}) {
    this.#rest = rest;
    this.#options = options;
  }

  async load(guildId: string, userIds: readonly string[]): Promise<Map<string, MemberContext>> {
    const now = this.#options.now?.() ?? new Date();
    const tier = await tierFor(guildId, this.#options);
    const loaded = new Map<string, MemberContext>();

    await Promise.all(
      userIds.map(async (userId) => {
        const response = await this.#rest.request({
          method: 'GET',
          path: `/guilds/${guildId}/members/${userId}`,
        });

        if (response.status >= 400) {
          if (response.status !== 404) {
            this.#options.onUnavailable?.(
              guildId,
              `the REST proxy answered ${response.status} for member ${userId}`,
              response.status,
            );
          }

          // 404 is a fact, not an outage: they left. A context with no member is what makes a
          // draw disqualify them rather than judging them on the roles they used to hold.
          const absent = absentMemberContext(guildId, userId, now, tier);
          if (absent) loaded.set(userId, absent);
          return;
        }

        const ctx = memberContextFromGuildMember(guildId, response.body, now, tier);
        if (ctx) loaded.set(userId, ctx);
      }),
    );

    return loaded;
  }
}

// One page per thousand members, not one request per entrant: revalidating ten thousand entrants
// through the per-member endpoint would be ten thousand REST calls for a single draw.
export class BulkMemberContextLoader implements MemberContextLoader {
  readonly #rest: RestProxyClient;
  readonly #options: MemberLoaderOptions;
  readonly #pageSize: number;

  constructor(rest: RestProxyClient, options: MemberLoaderOptions & { pageSize?: number } = {}) {
    this.#rest = rest;
    this.#options = options;
    this.#pageSize = Math.min(options.pageSize ?? MEMBER_PAGE_MAX, MEMBER_PAGE_MAX);
  }

  async load(guildId: string, userIds: readonly string[]): Promise<Map<string, MemberContext>> {
    const now = this.#options.now?.() ?? new Date();
    const tier = await tierFor(guildId, this.#options);

    const wanted = new Set(userIds);
    const loaded = new Map<string, MemberContext>();

    let after = '0';
    let complete = false;
    for (;;) {
      const response = await this.#rest.request({
        method: 'GET',
        path: `/guilds/${guildId}/members?limit=${this.#pageSize}&after=${after}`,
      });

      if (response.status >= 400 || !Array.isArray(response.body)) {
        this.#options.onUnavailable?.(
          guildId,
          listFailure(response.status, response.body),
          response.status,
        );
        break;
      }

      const page: unknown[] = response.body;

      let highest = after;
      for (const raw of page) {
        const ctx = memberContextFromGuildMember(guildId, raw, now, tier);
        if (!ctx) continue;

        if (BigInt(ctx.userId) > BigInt(highest)) highest = ctx.userId;
        if (wanted.has(ctx.userId)) loaded.set(ctx.userId, ctx);
      }

      if (page.length < this.#pageSize) {
        complete = true;
        break;
      }

      if (highest === after) {
        this.#options.onUnavailable?.(
          guildId,
          `the member list stopped advancing after user ${after}, so members above it were not read`,
        );
        break;
      }

      after = highest;
    }

    for (const userId of wanted) {
      if (loaded.has(userId)) continue;

      // Unreached means unknown: an absent context would disqualify them as having left.
      const absent = absentMemberContext(guildId, userId, now, tier);
      if (absent && (complete || BigInt(userId) <= BigInt(after))) loaded.set(userId, absent);
    }

    return loaded;
  }
}
