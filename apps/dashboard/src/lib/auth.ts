import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { OAUTH_SCOPES } from '../components/site/catalogue.ts';
import { db } from './db.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  socialProviders: {
    discord: {
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      disableDefaultScope: true,
      scope: [...OAUTH_SCOPES],
      // Better Auth needs a unique email per user; without the email scope Discord sends none.
      mapProfileToUser: (profile) => ({
        email: `${profile.id}@users.discord.invalid`,
        emailVerified: false,
      }),
    },
  },
  account: {
    accountLinking: { enabled: false },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }),
      },
    },
  },

  // Better Auth's default is `${baseURL}/error`, which is not a route here — so declining the
  // Discord consent screen landed on a not-found instead of back at the door that sent you.
  onAPIError: {
    errorURL: '/',
  },
});

export type Auth = typeof auth;
