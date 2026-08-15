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

export async function getDiscordAccessToken(headers: Headers, userId: string): Promise<string> {
  try {
    const result = (await auth.api.getAccessToken({
      body: { providerId: 'discord' },
      headers,
    })) as { accessToken?: string } | undefined;

    if (result?.accessToken) return result.accessToken;
  } catch {}

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
