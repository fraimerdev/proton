import { caseQuerySchema, leaderboardQuerySchema } from '@proton/core';
import { tagQuerySchema } from '@proton/module-tags/query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { fetchGuildChannels, fetchGuildRoles, fetchUserGuilds } from '../lib/discord.ts';
import { getDiscordAccessToken } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { administrableGuilds, type DiscordUserGuild, withPresence } from '../lib/guild-access.ts';
import {
  requireGuildAccess,
  requireManageGuild,
  requireSession,
} from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

// Every server reads as one Proton is in when this lookup fails, which is the list as it was
// before presence existed. Failing the other way would tell an admin the bot had left a server
// it is still sitting in, over nothing worse than the api being briefly unreachable.
async function presentIds(guilds: readonly DiscordUserGuild[]): Promise<Set<string>> {
  const ids = guilds.map((guild) => guild.id);

  try {
    return new Set(await api.guildPresence(ids));
  } catch (error) {
    console.warn(
      'the api could not say which servers Proton is in, showing them all as joined:',
      error,
    );
    return new Set(ids);
  }
}

export const listGuilds = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .handler(async ({ context }) => {
    const token = await getDiscordAccessToken(getRequest().headers, context.session.user.id);
    const user = context.session.user;
    const guilds = administrableGuilds(await fetchUserGuilds(env.REST_PROXY_URL, token));

    return {
      guilds: withPresence(guilds, await presentIds(guilds)),
      user: { id: user.id, name: user.name, image: user.image ?? null },
    };
  });

export const getGuildOverview = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.getGuild(data.guildId));

export const listModules = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.listModules(data.guildId));

export const getModuleConfig = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1), moduleId: z.string().min(1) }))
  .handler(({ data }) => api.getModule(data.guildId, data.moduleId));

export const getModuleDescriptors = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1), moduleId: z.string().min(1) }))
  .handler(({ data }) => api.getModuleDescriptors(data.guildId, data.moduleId));

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

export const searchTags = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(tagQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.searchTags(guildId, query);
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
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.updateModule(data.guildId, data.moduleId, {
        enabled: data.enabled,
        config: data.config,
        ...stamp,
      }),
    ),
  );
