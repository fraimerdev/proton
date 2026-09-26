import { snowflakeSchema } from '@proton/core';
import { exportQuerySchema } from '@proton/module-applications/view';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { auth } from '../../../../lib/auth.ts';
import { expiredSignInResponse, fetchUserGuilds } from '../../../../lib/discord.ts';
import { getDiscordAccessToken, getDiscordUserId } from '../../../../lib/discord-token.ts';
import { loadEnv } from '../../../../lib/env.ts';
import { apiQuery, rawApplicationsApi } from '../../../../server/applications-api.ts';

const env = loadEnv();

const refusalSchema = z.object({ error: z.string().optional(), message: z.string() });

const FORWARDED = ['content-type', 'content-disposition', 'x-proton-export-rows'] as const;

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function viewerOf(request: Request, guildId: string): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return plain('Your session has ended. Reload this page to sign in again.', 401);
  }

  const token = await getDiscordAccessToken(request.headers, session.user.id);
  const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token).catch(expiredSignInResponse);
  if (guilds instanceof Response) return guilds;

  if (!guilds.some((guild) => guild.id === guildId)) {
    return plain('You’re no longer a member of this server.', 403);
  }

  return getDiscordUserId(session.user.id);
}

function statusOf(code: string | undefined, status: number): number {
  if (code === 'not_allowed' || code === 'not_member') return 403;
  if (status >= 400 && status < 600) return status;
  return 502;
}

async function refusal(upstream: Response): Promise<Response> {
  const body = refusalSchema.safeParse(await upstream.json().catch(() => null));

  return body.success
    ? plain(body.data.message, statusOf(body.data.error, upstream.status))
    : plain('Proton couldn’t prepare the file. Try again in a moment.', 502);
}

export const Route = createFileRoute('/api/guilds/$guildId/applications-export')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!snowflakeSchema.safeParse(params.guildId).success) {
          return plain('No such server.', 404);
        }

        const query = exportQuerySchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success) {
          return plain('That download link isn’t valid. Choose Export again.', 400);
        }

        const viewer = await viewerOf(request, params.guildId);
        if (viewer instanceof Response) return viewer;

        const upstream = await rawApplicationsApi(
          `/guilds/${params.guildId}/applications/export${apiQuery({
            ...query.data,
            viewerId: viewer,
          })}`,
        );
        if (!upstream.ok) return refusal(upstream);

        const headers = new Headers({
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-proton-export-truncated': upstream.headers.get('x-proton-export-truncated') ?? '0',
        });
        for (const name of FORWARDED) {
          const value = upstream.headers.get(name);
          if (value !== null) headers.set(name, value);
        }

        return new Response(upstream.body, { headers });
      },
    },
  },
});
