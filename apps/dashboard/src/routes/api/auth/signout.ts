import { createFileRoute } from '@tanstack/react-router';
import { auth } from '../../../lib/auth.ts';
import { SIGN_OUT_CALLBACK_URL } from '../../../lib/auth-redirects.ts';

export const Route = createFileRoute('/api/auth/signout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const response = await auth.api.signOut({ headers: request.headers, asResponse: true });

        const headers = new Headers();
        for (const cookie of response.headers.getSetCookie()) {
          headers.append('set-cookie', cookie);
        }
        headers.set('location', SIGN_OUT_CALLBACK_URL);

        return new Response(null, { status: 302, headers });
      },
    },
  },
});
