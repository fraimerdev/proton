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

export const requireSession = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const session = await auth.api.getSession({ headers: getRequest().headers });
  if (!session?.user) throw new ForbiddenError('not signed in');

  return next({ context: { session } });
});

export const requireGuildAccess = createMiddleware({ type: 'function' })
  .middleware([requireSession])

  .validator(z.looseObject({ guildId: z.string().min(1) }))
  .server(async ({ next, data, context }) => {
    const token = await getDiscordAccessToken(getRequest().headers, context.session.user.id);

    const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token);
    const access = resolveGuildAccess(guilds, data.guildId);

    if (!access) throw new ForbiddenError('you do not administer that server');

    return next({ context: { ...context, access } });
  });

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
