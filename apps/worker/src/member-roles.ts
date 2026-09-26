import type { ResolveContextDeps, RestProxyClient } from '@proton/core';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';

export interface FetchMemberRolesOptions {
  onUnavailable?(guildId: string, userId: string, status: number): void;
}

const discordErrorSchema = z.looseObject({ code: z.number().int().optional() });

export function isNotMember(status: number, body: unknown): boolean {
  if (status !== 404) return false;

  const error = discordErrorSchema.safeParse(body);
  const code = error.success ? error.data.code : undefined;
  return code === RESTJSONErrorCodes.UnknownMember || code === RESTJSONErrorCodes.UnknownUser;
}

export function createMemberRolesLookup(
  rest: RestProxyClient,
  options: FetchMemberRolesOptions = {},
): NonNullable<ResolveContextDeps['fetchMemberRoles']> {
  return async (guildId, userId) => {
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
    });

    if (response.status >= 400) {
      if (isNotMember(response.status, response.body)) return 'not_member';
      options.onUnavailable?.(guildId, userId, response.status);
      return null;
    }

    const roles = (response.body as { roles?: unknown })?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : null;
  };
}

export function createFetchMemberRoles(
  rest: RestProxyClient,
  options: FetchMemberRolesOptions = {},
): (guildId: string, userId: string) => Promise<string[] | null> {
  const lookup = createMemberRolesLookup(rest, options);

  return async (guildId, userId) => {
    const roles = await lookup(guildId, userId);
    return roles === 'not_member' ? null : roles;
  };
}
