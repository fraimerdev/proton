import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { auth } from '../lib/auth.ts';
import { fetchGuildChannels, fetchUserGuilds } from '../lib/discord.ts';
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
  .handler(async () => {
    const accounts = await auth.api.listUserAccounts({ headers: getRequest().headers });
    const token = (
      accounts?.find((a) => a.providerId === 'discord') as { accessToken?: string } | undefined
    )?.accessToken;

    if (!token) return { guilds: [] };

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
