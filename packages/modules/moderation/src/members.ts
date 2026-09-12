import { MEMBER_PAGE_MAX, type RestProxyClient } from '@proton/core';

export interface GuildMemberSummary {
  userId: string;
  bot: boolean;
  roleIds: string[];
}

export interface MemberPage {
  members: GuildMemberSummary[];

  /** Cursor for the next page. Null means this was the last one. */
  next: string | null;
}

export interface MemberPageFailure {
  failure: string;

  /** False for a refusal that will read the same way however many times it is asked. */
  retryable: boolean;
}

export type MemberPageResult = MemberPage | MemberPageFailure;

export interface GuildMemberLister {
  list(guildId: string, after: string, limit: number): Promise<MemberPageResult>;
}

function summarise(raw: unknown): GuildMemberSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const member = raw as { user?: unknown; roles?: unknown };
  const user = member.user;
  if (typeof user !== 'object' || user === null) return null;

  const { id, bot } = user as { id?: unknown; bot?: unknown };
  if (typeof id !== 'string' || id.length === 0) return null;

  return {
    userId: id,
    bot: bot === true,
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

    if (response.status === 403) {
      return {
        retryable: false,
        failure:
          'Listing this server’s members needs the Server Members privileged intent, and ' +
          'Discord is refusing it to this application. Turn it on under Bot → Privileged ' +
          'Gateway Intents in the Discord developer portal.',
      };
    }

    if (response.status >= 400) {
      return {
        // 4xx other than the intent refusal included: a 429 the proxy gave up on and a 404 on a
        // guild mid-outage both come back the same way, and both read differently a minute later.
        retryable: true,
        failure: `Discord answered ${response.status} when I asked for the member list.`,
      };
    }

    const page = Array.isArray(response.body) ? response.body : [];
    const members = page.map(summarise).filter((m): m is GuildMemberSummary => m !== null);

    // Discord pages by ascending id, and a short page is the last one. Taking the highest id
    // rather than the last element's keeps the cursor monotonic even if a page arrives unsorted,
    // which is what stops a run looping over the same thousand members forever.
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
