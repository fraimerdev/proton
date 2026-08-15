import { Permissions } from '@proton/core';
import { createMiddleware } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { auth } from '../lib/auth.ts';
import { fetchUserGuilds } from '../lib/discord.ts';
import { getDiscordAccessToken } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { accessGrants, resolveGuildAccess } from '../lib/guild-access.ts';

const env = loadEnv();

export class ForbiddenError extends Error {
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Note the `{ type: 'function' }`.
 *
 * PLAN.md §9 writes this as a bare `createMiddleware()`, but that produces
 * *request* middleware, which has no `data` and cannot be attached to a server
 * function. See plan deviation D4.
 */
export const requireSession = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const session = await auth.api.getSession({ headers: getRequest().headers });
  if (!session?.user) throw new ForbiddenError('not signed in');

  return next({ context: { session } });
});

/**
 * Resolve, server-side, whether the caller may administer the requested guild.
 *
 * I6: the guild id arriving from the browser is only a lookup key. Access is
 * decided against the guild list Discord returns for this user's own token, so a
 * forged id resolves to nothing.
 */
export const requireGuildAccess = createMiddleware({ type: 'function' })
  .middleware([requireSession])
  /**
   * `looseObject`, and it has to be.
   *
   * Start runs validators as a pipeline and each one *replaces* the payload:
   * `ctx.data = await execValidator(validator, ctx.data)` in
   * `createServerFn.js`. A plain `z.object` strips unknown keys, so this
   * middleware — which only cares about `guildId` — was deleting every other
   * field before the server function's own validator ran.
   *
   * The damage was uneven, which is why it survived. `getModuleConfig` needs a
   * `moduleId` with no default, so every module settings page died on
   * "expected string, received undefined". `searchCases` has defaults or
   * `.optional()` on everything but `guildId`, so the case table rendered
   * perfectly while silently discarding the caller's filters, sort and page —
   * the worse of the two failures, because nothing looked wrong.
   *
   * A middleware validator here is a precondition, not a schema for the whole
   * call. It must narrow what it reads and pass the rest through untouched.
   */
  .validator(z.looseObject({ guildId: z.string().min(1) }))
  .server(async ({ next, data, context }) => {
    // `listUserAccounts` redacts tokens by design, so reading accessToken off it
    // always yielded undefined and every guild page 403'd with "no linked
    // Discord account" — blaming the user's Discord for our own lookup.
    const token = await getDiscordAccessToken(getRequest().headers, context.session.user.id);

    const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token);
    const access = resolveGuildAccess(guilds, data.guildId);

    if (!access) throw new ForbiddenError('you do not administer that server');

    return next({ context: { ...context, access } });
  });

/** Require a specific Discord permission on top of guild access. */
export function requirePermission(permission: bigint) {
  return createMiddleware({ type: 'function' })
    .middleware([requireGuildAccess])
    .server(async ({ next, context }) => {
      if (!accessGrants(context.access, permission)) {
        throw new ForbiddenError('you lack the required permission in that server');
      }
      return next({ context });
    });
}

export const requireManageGuild = requirePermission(Permissions.ManageGuild);
