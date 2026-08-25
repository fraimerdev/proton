import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
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
      scope: ['identify', 'guilds', 'guilds.members.read'],
    },
  },
  account: {
    accountLinking: { enabled: false },
  },

  // Better Auth's default is `${baseURL}/error`, which is not a route here — so declining the
  // Discord consent screen landed on a not-found instead of back at the door that sent you.
  onAPIError: {
    errorURL: '/',
  },
});

export type Auth = typeof auth;
