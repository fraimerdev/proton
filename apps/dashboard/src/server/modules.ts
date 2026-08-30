import {
  BLOCK_REASON_MAX,
  blockedMemberQuerySchema,
  caseQuerySchema,
  leaderboardQuerySchema,
} from '@proton/core';
import { tagQuerySchema } from '@proton/module-tags/query';
import { ticketQuerySchema } from '@proton/module-tickets/query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { fetchGuildChannels, fetchGuildRoles, fetchUserGuilds } from '../lib/discord.ts';
import { getDiscordAccessToken } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { administrableGuilds, type DiscordUserGuild, withPresence } from '../lib/guild-access.ts';
import type { BotInvite } from '../lib/invite.ts';
import {
  requireGuildAccess,
  requireManageGuild,
  requireSession,
} from '../middleware/guild-access.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

interface Presence {
  present: Set<string>;
  known: boolean;
}

// Unreachable is its own answer, not a guess in either direction. Calling it joined hands an admin
// a settings page for a server Proton is not in, whose every save lands nowhere; calling it absent
// tells them the bot left servers it is still sitting in. The picker renders the third state.
async function presence(guilds: readonly DiscordUserGuild[]): Promise<Presence> {
  const ids = guilds.map((guild) => guild.id);
  if (ids.length === 0) return { present: new Set(), known: true };

  try {
    const answer = await api.guildPresence(ids);
    return { present: new Set(answer.present), known: answer.known };
  } catch (error) {
    console.warn('the api could not say which servers Proton is in:', error);
    return { present: new Set(), known: false };
  }
}

// null rather than a guess: the permission set is unioned over the modules the api has loaded, and
// an invite built from a stale or invented one asks Discord for the wrong scopes. The picker drops
// the button and falls back to whatever presence it does know.
async function botInvite(): Promise<BotInvite | null> {
  try {
    return { clientId: env.DISCORD_CLIENT_ID, permissions: await api.invitePermissions() };
  } catch (error) {
    console.warn('the api could not say what an invite needs, so none is offered:', error);
    return null;
  }
}

export const listGuilds = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .handler(async ({ context }) => {
    const token = await getDiscordAccessToken(getRequest().headers, context.session.user.id);
    const user = context.session.user;
    const guilds = administrableGuilds(await fetchUserGuilds(env.REST_PROXY_URL, token));

    const [joined, invite] = await Promise.all([presence(guilds), botInvite()]);

    return {
      guilds: withPresence(guilds, joined.present),
      presenceKnown: joined.known,
      invite,
      user: { id: user.id, name: user.name, image: user.image ?? null, email: user.email ?? null },
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

export const searchBlockedMembers = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(blockedMemberQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.searchBlockedMembers(guildId, query);
  });

// requireManageGuild, not requireGuildAccess: lifting a block restores somebody's way back into
// the server, which is a moderation decision rather than something a reader may make.
export const liftBlockedMember = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(
    z.object({
      guildId: z.string().min(1),
      userId: z.string().min(1),
      liftReason: z.string().trim().min(1).max(BLOCK_REASON_MAX),
    }),
  )
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.liftBlockedMember(data.guildId, data.userId, {
        ...stamp,
        liftReason: data.liftReason,
      }),
    ),
  );

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

export const searchTickets = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(ticketQuerySchema.extend({ guildId: z.string().min(1) }))
  .handler(({ data }) => {
    const { guildId, ...query } = data;
    return api.searchTickets(guildId, query);
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
