import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import type { RestProxyClient } from '../actions/rest-client.ts';
import { MEMBER_PAGE_MAX } from './rest-member-context.ts';

export interface GuildMemberSummary {
  userId: string;
  bot: boolean;
  pending: boolean;
  roleIds: string[];
}

export interface MemberPage {
  members: GuildMemberSummary[];
  next: string | null;
}

export interface MemberPageFailure {
  failure: string;
  retryable: boolean;
}

export type MemberPageResult = MemberPage | MemberPageFailure;

export interface GuildMemberLister {
  list(guildId: string, after: string, limit: number): Promise<MemberPageResult>;
}

export type UpstreamRefusal = 'forbidden' | 'not_found';

export function upstreamRefusal(status: number): UpstreamRefusal | null {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return null;
}

const discordErrorSchema = z.looseObject({ code: z.number().int().optional() });

function listFailure(status: number, body: unknown): MemberPageFailure {
  if (status >= 500) {
    return {
      retryable: true,
      failure: `Proton couldn't get the member list from Discord (error ${status}). Try again later.`,
    };
  }

  const parsed = discordErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;

  if (code === RESTJSONErrorCodes.MissingAccess) {
    return {
      retryable: false,
      failure:
        `Discord refused to list this server’s members (${status}, code ${code}). Either the ` +
        'Server Members Intent is off for Proton (turn it on in the Discord Developer Portal ' +
        'under Bot → Privileged Gateway Intents), or Proton is no longer in this server.',
    };
  }

  if (status === 403) {
    return {
      retryable: false,
      failure:
        code === undefined
          ? 'Discord refused to list this server’s members (403) and sent no Discord error code ' +
            'with it. Try again later.'
          : `Discord refused to list this server’s members (403, code ${code}).`,
    };
  }

  return {
    // a 404 on a guild mid-outage reads differently later
    retryable: true,
    failure:
      `Discord answered ${status}${code === undefined ? '' : ` (code ${code})`} when Proton ` +
      'asked for the member list.',
  };
}

function summarise(raw: unknown): GuildMemberSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const member = raw as { user?: unknown; roles?: unknown; pending?: unknown };
  const user = member.user;
  if (typeof user !== 'object' || user === null) return null;

  const { id, bot } = user as { id?: unknown; bot?: unknown };
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) return null;

  return {
    userId: id,
    bot: bot === true,
    pending: member.pending === true,
    roleIds: Array.isArray(member.roles)
      ? member.roles.filter((role): role is string => typeof role === 'string')
      : [],
  };
}

export class RestGuildMemberLister implements GuildMemberLister {
  readonly #rest: RestProxyClient;

  constructor(rest: RestProxyClient) {
    this.#rest = rest;
  }

  async list(guildId: string, after: string, limit: number): Promise<MemberPageResult> {
    const size = Math.min(Math.max(limit, 1), MEMBER_PAGE_MAX);

    const response = await this.#rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members?limit=${size}&after=${after}`,
    });

    if (response.status >= 400) return listFailure(response.status, response.body);

    const page = Array.isArray(response.body) ? response.body : [];
    const members = page.map(summarise).filter((m): m is GuildMemberSummary => m !== null);

    // the highest id, not the last element's: an unsorted page must still move the cursor forward
    let highest = after;
    for (const member of members) {
      if (BigInt(member.userId) > BigInt(highest)) highest = member.userId;
    }

    return {
      members,
      next: page.length < size || highest === after ? null : highest,
    };
  }
}
