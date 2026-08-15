import type { RestProxyClient } from '@proton/core';

/**
 * Look up one member's role ids through the REST proxy.
 *
 * One implementation, three consumers: the executor's `resolvePrecheckContext`
 * (for the I8 hierarchy check), anti-nuke's breaker (to know what to strip) and
 * verification's `/quarantine` (to know what to restore). They ask the same
 * question, so they get the same answer from the same code — three copies would
 * be three chances to disagree about what a missing member means.
 *
 * A single-member fetch, never Request Guild Members: §10.4 caps the all-members
 * form at one per guild per 30 seconds, which is useless to anything reacting to
 * an event.
 *
 * `null` means "could not read the roles", not "no roles". Callers must treat it
 * as unknown and fail closed — anti-nuke does exactly that, stripping nothing and
 * escalating to a human rather than guessing.
 */
export interface FetchMemberRolesOptions {
  /**
   * Reports a lookup that failed for a reason other than the member being gone.
   *
   * Optional so the function stays a plain `(guildId, userId) => roles | null`,
   * which is the shape all three callers already expect.
   */
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
      /**
       * 404 is a real answer — the member left — and every caller handles it.
       * 429, 403 and a 502 from the proxy are not: they mean "ask again", and
       * they arrive here as the same `null`.
       *
       * That collapse is deliberate, because the alternative is worse. The
       * callers that matter fail *closed* on null: anti-nuke's breaker strips
       * nothing and escalates to a human rather than guessing, and I8's
       * hierarchy check refuses the action. Turning a rate limit into a throw
       * would instead abort the whole handler mid-response. So the value stays
       * `null` and the distinction is surfaced to the log, where the operator
       * can see that a strip was skipped because Discord was rate limiting
       * rather than because the attacker had already left.
       */
      if (response.status !== 404) options.onUnavailable?.(guildId, userId, response.status);
      return null;
    }

    const roles = (response.body as { roles?: unknown })?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : null;
  };
}
