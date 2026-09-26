import { Permissions } from '@proton/core';
import { BADGE_ASSET_ID } from '@proton/module-achievements/config';
import { createFileRoute } from '@tanstack/react-router';
import { ApiClient } from '../../../../lib/api-client.ts';
import { auth } from '../../../../lib/auth.ts';
import { expiredSignInResponse, fetchUserGuilds } from '../../../../lib/discord.ts';
import { getDiscordAccessToken } from '../../../../lib/discord-token.ts';
import { loadEnv } from '../../../../lib/env.ts';
import { accessGrants, resolveGuildAccess } from '../../../../lib/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

function plain(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } });
}

async function allow(request: Request, guildId: string): Promise<true | Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return plain('Your session has ended. Reload this page to sign in again.', 403);

  const token = await getDiscordAccessToken(request.headers, session.user.id);
  const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token).catch(expiredSignInResponse);
  if (guilds instanceof Response) return guilds;

  const access = resolveGuildAccess(guilds, guildId);

  if (!access) return plain('You no longer have Manage Server in this server.', 403);

  if (!accessGrants(access, Permissions.ManageGuild)) {
    return plain('You need Manage Server in this server to see uploaded badge images.', 403);
  }

  return true;
}

export const Route = createFileRoute('/api/guilds/$guildId/achievement-badges/$assetId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!BADGE_ASSET_ID.test(params.assetId)) return plain('No such image.', 404);

        const allowed = await allow(request, params.guildId);
        if (allowed instanceof Response) return allowed;

        const upstream = await api.achievementBadge(params.guildId, params.assetId);
        if (!upstream.ok) return plain('This server has no badge image with that ID.', 404);

        return new Response(upstream.body, {
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'cache-control': 'private, max-age=86400, immutable',
          },
        });
      },
    },
  },
});
