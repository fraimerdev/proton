import { useState } from 'react';

export const SIGN_OUT_FAILED =
  'Proton could not end the session. You are still signed in — try again, or close the browser to drop the cookie.';

export function useSignOut(): { signOut: () => Promise<void>; failed: boolean } {
  const [failed, setFailed] = useState(false);

  // Neither the response nor a rejection was checked, so a sign-out the server refused looked
  // exactly like one that worked: the menu closed and the session stayed live.
  async function signOut(): Promise<void> {
    setFailed(false);

    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      if (!response.ok) {
        setFailed(true);
        return;
      }
    } catch {
      setFailed(true);
      return;
    }

    window.location.href = '/';
  }

  return { signOut, failed };
}
