import { Permissions } from '@proton/core';
import { createFileRoute } from '@tanstack/react-router';
import { ApiClient } from '../../../../lib/api-client.ts';
import { auth } from '../../../../lib/auth.ts';
import { fetchUserGuilds } from '../../../../lib/discord.ts';
import { getDiscordAccessToken } from '../../../../lib/discord-token.ts';
import { loadEnv } from '../../../../lib/env.ts';
import { accessGrants, resolveGuildAccess } from '../../../../lib/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

const PASSED_THROUGH = [
  'kind',
  'preset',
  'accent',
  'background',
  'displayName',
  'guildName',
  'showRank',
  'showPercent',
  'showTotalXp',
  'showMemberCount',
];

function forbidden(message: string): Response {
  return new Response(message, { status: 403, headers: { 'content-type': 'text/plain' } });
}

// A route rather than a server function: the answer is an image, and a server function would have
// to base64 it into JSON. The permission check is the same one every mutation runs (I11).
export const Route = createFileRoute('/api/guilds/$guildId/card-preview')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session?.user) return forbidden('not signed in');

        const token = await getDiscordAccessToken(request.headers, session.user.id);
        const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token);
        const access = resolveGuildAccess(guilds, params.guildId);

        if (!access) return forbidden('you do not administer that server');
        if (!accessGrants(access, Permissions.ManageGuild)) {
          return forbidden('you lack Manage Server in that server');
        }

        const asked = new URL(request.url).searchParams;
        const query: Record<string, unknown> = {};
        for (const key of PASSED_THROUGH) {
          const value = asked.get(key);
          if (value !== null && value !== '') query[key] = value;
        }

        // The signed-in user's own face and their server's real name, so the preview is a picture
        // of this guild's settings rather than of placeholder data.
        if (session.user.image) query.avatar = session.user.image;
        query.displayName ??= session.user.name;

        const guildName = guilds.find((guild) => guild.id === params.guildId)?.name;
        if (guildName) query.guildName ??= guildName;

        const upstream = await api.cardPreview(params.guildId, query);

        if (!upstream.ok) {
          return new Response(await upstream.text(), {
            status: upstream.status,
            headers: { 'content-type': 'text/plain' },
          });
        }

        return new Response(upstream.body, {
          headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
        });
      },
    },
  },
});
