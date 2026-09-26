import { Permissions } from '@proton/core';
import { isAssetKind } from '@proton/module-branding/kinds';
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

// A route rather than a server function: one direction carries image bytes and the other carries a
// file, and a server function would base64 both into JSON. The permission check is the one every
// mutation runs (I11).
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
    return plain('You need Manage Server in this server to change how Proton looks.', 403);
  }

  return { actorId: await getDiscordUserId(session.user.id) };
}

export const Route = createFileRoute('/api/guilds/$guildId/branding/$kind')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAssetKind(params.kind)) return plain('No such image.', 404);

        const allowed = await allow(request, params.guildId);
        if (allowed instanceof Response) return allowed;

        const upstream = await api.brandingAsset(params.guildId, params.kind);
        if (!upstream.ok) return plain('This server has no image of that kind saved.', 404);

        return new Response(upstream.body, {
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'cache-control': 'no-store',
          },
        });
      },

      PUT: async ({ request, params }) => {
        if (!isAssetKind(params.kind)) return plain('No such image.', 404);

        const allowed = await allow(request, params.guildId);
        if (allowed instanceof Response) return allowed;

        const upstream = await api.uploadBrandingAsset(
          params.guildId,
          params.kind,
          await request.arrayBuffer(),
          allowed.actorId,
        );

        const body = (await upstream.json().catch(() => ({}))) as { message?: string };
        if (!upstream.ok) {
          return plain(
            body.message ?? "Proton couldn't save that image. Try again.",
            upstream.status,
          );
        }

        return Response.json(body);
      },

      DELETE: async ({ request, params }) => {
        if (!isAssetKind(params.kind)) return plain('No such image.', 404);

        const allowed = await allow(request, params.guildId);
        if (allowed instanceof Response) return allowed;

        const upstream = await api.clearBrandingAsset(params.guildId, params.kind, allowed.actorId);
        if (!upstream.ok) {
          const body = (await upstream.json().catch(() => ({}))) as { message?: string };
          return plain(
            body.message ?? "Proton couldn't remove that image. Try again.",
            upstream.status,
          );
        }

        return Response.json({ ok: true });
      },
    },
  },
});
