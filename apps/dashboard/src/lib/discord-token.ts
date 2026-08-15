import { createDb } from '@proton/db';
import { account } from '@proton/db/schema';
import { and, eq } from 'drizzle-orm';
import { auth } from './auth.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();

export class MissingDiscordTokenError extends Error {
  constructor(detail: string) {
    super(
      `Could not read your Discord access token (${detail}). ` +
        'Sign out and sign in again to reconnect your Discord account.',
    );
    this.name = 'MissingDiscordTokenError';
  }
}

/**
 * The signed-in user's Discord OAuth access token.
 *
 * `auth.api.listUserAccounts` looks like the way to get this and is not — it
 * deliberately redacts tokens and returns account metadata only. Reading
 * `accessToken` off its result yields `undefined` every time, which previously
 * turned an auth failure into an empty guild list and a dashboard cheerfully
 * reporting "You do not administer any server" to someone who administers five.
 *
 * `getAccessToken` is the supported path and refreshes an expired token. The
 * database read behind it is a fallback for the case where that API is
 * unavailable, and it deliberately does NOT refresh — an expired token there
 * surfaces as a Discord 401 the caller can report, rather than silence.
 */
export async function getDiscordAccessToken(headers: Headers, userId: string): Promise<string> {
  try {
    const result = (await auth.api.getAccessToken({
      body: { providerId: 'discord' },
      headers,
    })) as { accessToken?: string } | undefined;

    if (result?.accessToken) return result.accessToken;
  } catch {
    // Fall through to the database. A throw here means the endpoint is absent
    // or the account is unlinked; both are better diagnosed by what follows.
  }

  const handle = createDb(env.DATABASE_URL);
  try {
    const rows = await handle.db
      .select({ accessToken: account.accessToken })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'discord')))
      .limit(1);

    const token = rows[0]?.accessToken;
    if (!token) throw new MissingDiscordTokenError('no linked Discord account');
    return token;
  } finally {
    await handle.close();
  }
}
