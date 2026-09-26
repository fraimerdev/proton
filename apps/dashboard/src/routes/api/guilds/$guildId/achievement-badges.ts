import { Permissions } from '@proton/core';
import { BADGE_UPLOAD_MAX_BYTES, badgeUploadResultSchema } from '@proton/module-achievements/view';
import { createFileRoute } from '@tanstack/react-router';
import { ApiClient } from '../../../../lib/api-client.ts';
import { auth } from '../../../../lib/auth.ts';
import { expiredSignInResponse, fetchUserGuilds } from '../../../../lib/discord.ts';
import { getDiscordAccessToken, getDiscordUserId } from '../../../../lib/discord-token.ts';
import { loadEnv } from '../../../../lib/env.ts';
import { accessGrants, resolveGuildAccess } from '../../../../lib/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

function plain(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } });
}

interface Allowed {
  actorId: string;
}

// A route rather than a server function: the upload carries image bytes, and a server function
// would base64 them into JSON. The permission check is the one every mutation runs (I11).
async function allow(request: Request, guildId: string): Promise<Allowed | Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return plain('Your session has ended. Reload this page to sign in again.', 403);

  const token = await getDiscordAccessToken(request.headers, session.user.id);
  const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token).catch(expiredSignInResponse);
  if (guilds instanceof Response) return guilds;

  const access = resolveGuildAccess(guilds, guildId);

  if (!access) return plain('You no longer have Manage Server in this server.', 403);

  if (!accessGrants(access, Permissions.ManageGuild)) {
    return plain('You need Manage Server in this server to upload badge images.', 403);
  }

  return { actorId: await getDiscordUserId(session.user.id) };
}

export const Route = createFileRoute('/api/guilds/$guildId/achievement-badges')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        const allowed = await allow(request, params.guildId);
        if (allowed instanceof Response) return allowed;

        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > BADGE_UPLOAD_MAX_BYTES) {
          return plain(
            `Couldn't save that image. Badge images can be up to ${BADGE_UPLOAD_MAX_BYTES / 1024} KB.`,
            413,
          );
        }

        const upstream = await api.uploadAchievementBadge(params.guildId, bytes, allowed.actorId);

        const body = (await upstream.json().catch(() => ({}))) as { message?: string };
        if (!upstream.ok) {
          return plain(
            body.message ?? "Proton couldn't save that image. Try again.",
            upstream.status,
          );
        }

        const parsed = badgeUploadResultSchema.safeParse(body);
        if (!parsed.success) {
          return plain("The image was saved, but Proton didn't confirm it. Reload the page.", 502);
        }

        return Response.json(parsed.data);
      },
    },
  },
});
