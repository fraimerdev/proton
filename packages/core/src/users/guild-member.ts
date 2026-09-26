import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import type { RestProxyClient, RestResponse } from '../actions/rest-client.ts';

export type GuildMemberRead =
  | { state: 'member'; raw: Record<string, unknown>; roleIds: string[]; joinedAt: number | null }
  | { state: 'absent' }
  | { state: 'unavailable'; status?: number };

const ABSENT_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownMember,
  RESTJSONErrorCodes.UnknownUser,
]);

const discordErrorSchema = z.looseObject({ code: z.number().int().optional() });

const guildMemberSchema = z.looseObject({
  roles: z.array(z.string()),
  joined_at: z.string().nullish(),
});

function epochOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

// A bare 404 may be the proxy's own; reading it as absent would treat an outage as a departure.
function isAbsent(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  const error = discordErrorSchema.safeParse(body);
  return error.success && error.data.code !== undefined && ABSENT_CODES.has(error.data.code);
}

export async function readGuildMember(
  rest: RestProxyClient,
  guildId: string,
  userId: string,
  options: { timeoutMs?: number } = {},
): Promise<GuildMemberRead> {
  let response: RestResponse;
  try {
    response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch {
    return { state: 'unavailable' };
  }

  if (response.status >= 200 && response.status < 300) {
    const member = guildMemberSchema.safeParse(response.body);
    if (!member.success) return { state: 'unavailable', status: response.status };

    return {
      state: 'member',
      raw: member.data,
      roleIds: member.data.roles,
      joinedAt: epochOf(member.data.joined_at),
    };
  }

  return isAbsent(response.status, response.body)
    ? { state: 'absent' }
    : { state: 'unavailable', status: response.status };
}
