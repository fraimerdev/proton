import { caseQuerySchema, leaderboardQuerySchema } from '@proton/core';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { fetchGuildChannels, fetchGuildRoles, fetchUserGuilds } from '../lib/discord.ts';
import { getDiscordAccessToken, getDiscordUserId } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { administrableGuilds, withPresence } from '../lib/guild-access.ts';
import {
  requireGuildAccess,
  requireManageGuild,
  requireSession,
} from '../middleware/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

async function ipHash(): Promise<string | undefined> {
  const raw =
    getRequest().headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    getRequest().headers.get('x-real-ip');
  if (!raw) return undefined;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export const listGuilds = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .handler(async ({ context }) => {
    const token = await getDiscordAccessToken(getRequest().headers, context.session.user.id);

    const administrable = administrableGuilds(await fetchUserGuilds(env.REST_PROXY_URL, token));
    const { present } = await api.guildPresence(administrable.map((g) => g.id));

    return { guilds: withPresence(administrable, new Set(present)) };
  });

export const listModules = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.listModules(data.guildId));

export const getModuleConfig = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1), moduleId: z.string().min(1) }))
  .handler(({ data }) => api.getModule(data.guildId, data.moduleId));

export const getGuildChannels = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => fetchGuildChannels(env.REST_PROXY_URL, data.guildId));

export const getGuildRoles = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => fetchGuildRoles(env.REST_PROXY_URL, data.guildId));

export const searchCases = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(caseQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.searchCases(guildId, query);
  });

export const searchLeaderboard = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(leaderboardQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.searchLeaderboard(guildId, query);
  });

export const updateModuleConfig = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(
    z.object({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
      enabled: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const [hash, actorId] = await Promise.all([
      ipHash(),
      getDiscordUserId(context.session.user.id),
    ]);

    return api.updateModule(data.guildId, data.moduleId, {
      enabled: data.enabled,
      config: data.config,
      actorId,
      source: 'dashboard',
      ipHash: hash,
    });
  });
