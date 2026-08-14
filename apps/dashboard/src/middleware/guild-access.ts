import { Permissions } from '@proton/core';
import { createMiddleware } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { auth } from '../lib/auth.ts';
import { fetchUserGuilds } from '../lib/discord.ts';
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
  .validator(z.object({ guildId: z.string().min(1) }))
  .server(async ({ next, data, context }) => {
    const accounts = await auth.api.listUserAccounts({ headers: getRequest().headers });
    const discord = accounts?.find((a) => a.providerId === 'discord');
    const token = (discord as { accessToken?: string } | undefined)?.accessToken;

    if (!token) throw new ForbiddenError('no linked Discord account');

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
