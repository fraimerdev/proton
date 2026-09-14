import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponse } from '@tanstack/react-start/server';
import { auth } from '../lib/auth.ts';

/**
 * Better Auth clears the session cookie by writing Set-Cookie onto the response it is handed, so
 * the headers it produces have to be copied onto this function's own response or the browser keeps
 * the cookie and the next page load is signed in again.
 */
export const signOut = createServerFn({ method: 'POST' }).handler(async () => {
  const response = await auth.api.signOut({
    headers: getRequest().headers,
    returnHeaders: true,
  });

  const outgoing = getResponse()?.headers;

  if (outgoing) {
    for (const cookie of response.headers.getSetCookie()) outgoing.append('set-cookie', cookie);
  }

  return { ok: true };
});
