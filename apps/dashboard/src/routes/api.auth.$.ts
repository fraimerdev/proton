import { createFileRoute } from '@tanstack/react-router';
import { auth } from '../lib/auth.ts';

/**
 * Better Auth's handler. Discord's redirect URI must point here:
 *   http://localhost:3000/api/auth/callback/discord
 */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
});
