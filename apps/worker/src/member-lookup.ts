import type { RestProxyClient } from '@proton/core';
import type { MemberLookup } from '@proton/module-moderation';
import { z } from 'zod';

export const UNKNOWN_MEMBER_CODE = 10007;

const discordErrorSchema = z.object({ code: z.number().int().optional() });

const memberSchema = z.object({
  roles: z.array(z.string()).default([]),
  joined_at: z.string().nullish(),
  communication_disabled_until: z.string().nullish(),
});

export function epochOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

// A bare 404 may be the proxy's own; reading it as absent would ban past the hierarchy checks.
export function isUnknownMember(status: number, body: unknown): boolean {
  if (status !== 404) return false;

  const error = discordErrorSchema.safeParse(body);
  return error.success && error.data.code === UNKNOWN_MEMBER_CODE;
}

export function readMemberLookup(status: number, body: unknown): MemberLookup {
  if (status >= 200 && status < 300) {
    const member = memberSchema.safeParse(body);
    if (!member.success) return { state: 'unavailable', status };

    return {
      state: 'member',
      roleIds: member.data.roles,
      timeoutUntil: epochOf(member.data.communication_disabled_until),
      joinedAt: epochOf(member.data.joined_at),
    };
  }

  return isUnknownMember(status, body) ? { state: 'absent' } : { state: 'unavailable', status };
}

export function createMemberLookup(
  rest: RestProxyClient,
): (guildId: string, userId: string) => Promise<MemberLookup> {
  return async (guildId, userId) => {
    try {
      const response = await rest.request({
        method: 'GET',
        path: `/guilds/${guildId}/members/${userId}`,
      });
      return readMemberLookup(response.status, response.body);
    } catch {
      return { state: 'unavailable', status: 0 };
    }
  };
}
