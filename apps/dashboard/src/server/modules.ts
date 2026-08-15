import { caseQuerySchema } from '@proton/core';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { fetchGuildChannels, fetchGuildRoles, fetchUserGuilds } from '../lib/discord.ts';
import { getDiscordAccessToken } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { administrableGuilds } from '../lib/guild-access.ts';
import {
  requireGuildAccess,
  requireManageGuild,
  requireSession,
} from '../middleware/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

/** Hash the caller's IP — audit_trail stores a hash, never the address itself. */
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
    // No `return { guilds: [] }` on failure. Reporting "you administer no
    // servers" to someone who administers five is worse than an error, because
    // it looks like a settled answer and sends them looking at their Discord
    // permissions instead of at us. Let it throw.
    const token = await getDiscordAccessToken(getRequest().headers, context.session.user.id);

    return { guilds: administrableGuilds(await fetchUserGuilds(env.REST_PROXY_URL, token)) };
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

/**
 * The case browser's query (Gate 1).
 *
 * Thin, like every server function here: `requireGuildAccess` decides whether
 * this user may see this guild's history at all (I6 — the guild id in the URL is
 * only a lookup key), and the query itself is the API's, so `/history` in
 * Discord and the dashboard table cannot disagree about what a filter means.
 */
export const searchCases = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(caseQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.searchCases(guildId, query);
  });

/**
 * The mutation Gate 0's acceptance run exercises.
 *
 * Note how little happens here: authenticate, authorise, then delegate. The
 * validation, `schema_version` stamping and `audit_trail` write all live in the
 * API service, which the worker calls too (PLAN.md §9).
 */
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
    const hash = await ipHash();

    return api.updateModule(data.guildId, data.moduleId, {
      enabled: data.enabled,
      config: data.config,
      actorId: context.session.user.id,
      source: 'dashboard',
      ipHash: hash,
    });
  });
