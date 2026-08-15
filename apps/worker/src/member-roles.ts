import type { RestProxyClient } from '@proton/core';

export interface FetchMemberRolesOptions {
  onUnavailable?(guildId: string, userId: string, status: number): void;
}

export function createFetchMemberRoles(
  rest: RestProxyClient,
  options: FetchMemberRolesOptions = {},
): (guildId: string, userId: string) => Promise<string[] | null> {
  return async (guildId, userId) => {
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
    });

    if (response.status >= 400) {
      if (response.status !== 404) options.onUnavailable?.(guildId, userId, response.status);
      return null;
    }

    const roles = (response.body as { roles?: unknown })?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : null;
  };
}
