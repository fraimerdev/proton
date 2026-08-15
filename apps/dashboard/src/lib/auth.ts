import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { createDb } from '@proton/db';
import { betterAuth } from 'better-auth';
import { loadEnv } from './env.ts';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);

export const auth = betterAuth({
  database: drizzleAdapter(handle.db, { provider: 'pg' }),
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
});

export type Auth = typeof auth;
