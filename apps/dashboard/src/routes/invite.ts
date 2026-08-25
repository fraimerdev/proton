import { createFileRoute } from '@tanstack/react-router';
import { ApiClient } from '../lib/api-client.ts';
import { loadEnv } from '../lib/env.ts';
import { botInviteUrl } from '../lib/invite.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

export const Route = createFileRoute('/invite')({
  server: {
    handlers: {
      // No guild is pinned: this link is shared before anyone has picked a server, so Discord's own
      // picker is the right one. The per-server Add button on the picker page still pins its guild.
      GET: async () => {
        try {
          const permissions = await api.invitePermissions();

          return redirectTo(botInviteUrl({ clientId: env.DISCORD_CLIENT_ID, permissions }));
        } catch (error) {
          console.warn('the api could not say what an invite needs, so none was started:', error);

          return redirectTo('/?notice=invite-unavailable');
        }
      },
    },
  },
});
