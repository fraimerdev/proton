import { createFileRoute } from '@tanstack/react-router';
import { auth } from '../lib/auth.ts';

/**
 * GET entry point for the Discord OAuth dance.
 *
 * Better Auth only ships `POST /api/auth/sign-in/social`, which answers with the
 * authorize URL as JSON — a link cannot use it, and fetching it would put signing
 * in behind client JS. This route makes that call server-side and turns the answer
 * into a redirect, so the sign-in link stays a link.
 *
 * `asResponse` matters: sign-in sets a signed `state` cookie that the callback
 * checks against the stored verification, so a login whose Set-Cookie was dropped
 * dies at `/api/auth/callback/discord` with a state mismatch.
 *
 * `callbackURL` is fixed rather than read from the query string; a caller-supplied
 * destination here is an open redirect.
 */
export const Route = createFileRoute('/api/auth/signin/discord')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const response = await auth.api.signInSocial({
          body: { provider: 'discord', callbackURL: '/guilds' },
          headers: request.headers,
          asResponse: true,
        });

        const body = (await response.json()) as { url?: string };

        if (!response.ok || !body.url) {
          throw new Error(
            `Discord sign-in did not return an authorize URL (${response.status}). ` +
              'Check DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.',
          );
        }

        const headers = new Headers();
        for (const cookie of response.headers.getSetCookie()) {
          headers.append('set-cookie', cookie);
        }
        headers.set('location', body.url);

        return new Response(null, { status: 302, headers });
      },
    },
  },
});
