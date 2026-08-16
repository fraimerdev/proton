import { createFileRoute } from '@tanstack/react-router';
import { auth } from '../../../../lib/auth.ts';

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
