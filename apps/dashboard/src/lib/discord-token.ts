import { account } from '@proton/db/schema';
import { and, eq } from 'drizzle-orm';
import { auth } from './auth.ts';
import { db } from './db.ts';

export class MissingDiscordTokenError extends Error {
  constructor(detail: string) {
    super(
      `Could not read your Discord access token (${detail}). ` +
        'Sign out and sign in again to reconnect your Discord account.',
    );
    this.name = 'MissingDiscordTokenError';
  }
}

export class MissingDiscordAccountError extends Error {
  constructor() {
    super(
      'Could not read your Discord user id. Sign out and sign in again to reconnect your ' +
        'Discord account.',
    );
    this.name = 'MissingDiscordAccountError';
  }
}

// Better Auth's `user.id` is its own identifier, not a Discord snowflake. Anything recorded as
// an actor — an audit row, a log embed — needs the Discord id, which lives on the linked account.
export async function getDiscordUserId(userId: string): Promise<string> {
  const rows = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'discord')))
    .limit(1);

  const accountId = rows[0]?.accountId;
  if (!accountId) throw new MissingDiscordAccountError();

  return accountId;
}

export async function getDiscordAccessToken(headers: Headers, userId: string): Promise<string> {
  try {
    const result = (await auth.api.getAccessToken({
      body: { providerId: 'discord' },
      headers,
    })) as { accessToken?: string } | undefined;

    if (result?.accessToken) return result.accessToken;
  } catch (error) {
    console.warn(
      'better-auth could not hand back the Discord access token, falling back to the account row:',
      error,
    );
  }

  const rows = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'discord')))
    .limit(1);

  const token = rows[0]?.accessToken;
  if (!token) throw new MissingDiscordTokenError('no linked Discord account');

  return token;
}
