import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { auth } from '../lib/auth.ts';

export interface SignedInUser {
  name: string;
}

// The root route renders on every page, including the signed-out ones. A database that is down
// must not take `/` and `/privacy` with it, so a failed lookup reads as "signed out".
export const currentUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SignedInUser | null> => {
    const headers = getRequest().headers;
    const session = await auth.api.getSession({ headers }).catch(() => null);

    return session?.user ? { name: session.user.name } : null;
  },
);
