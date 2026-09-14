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
import { auth } from '../lib/auth.ts';
import type { GuildMember } from '../lib/discord.ts';
import {
  fetchCurrentUser,
  fetchGuildChannels,
  fetchGuildEmojis,
  fetchGuildMembers,
  fetchGuildRoles,
  fetchProtonAccount,
  fetchUserGuilds,
} from '../lib/discord.ts';
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
    const [allGuilds, profile] = await Promise.all([
      fetchUserGuilds(env.REST_PROXY_URL, token),
      fetchCurrentUser(env.REST_PROXY_URL, token),
    ]);
    const guilds = administrableGuilds(allGuilds);

    const [joined, invite] = await Promise.all([presence(guilds), botInvite()]);

    return {
      guilds: withPresence(guilds, joined.present),
      presenceKnown: joined.known,
      invite,
      user: {
        id: user.id,
        name: profile?.name ?? user.name,
        image: profile?.avatarUrl ?? user.image ?? null,
        email: user.email ?? null,
      },
    };
  });

export const getViewer = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await auth.api.getSession({ headers: getRequest().headers });

  return { signedIn: Boolean(session?.user) };
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
  // The client id is Proton's own user id, which is what turns "above Proton's own role" into
  // something the picker can say before the save instead of a 403 discovered days later.
  .handler(({ data }) => fetchGuildRoles(env.REST_PROXY_URL, data.guildId, env.DISCORD_CLIENT_ID));

export const getGuildEmojis = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => fetchGuildEmojis(env.REST_PROXY_URL, data.guildId));

export const getProtonAccount = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) =>
    fetchProtonAccount(env.REST_PROXY_URL, data.guildId, env.DISCORD_CLIENT_ID),
  );

// Discord has no batch member endpoint, so fetchGuildMembers is one upstream call per id. A 50-row
// case page carries up to 100 distinct ids and the next page carries most of the same ones, so the
// cache is what stops the same hundred reads going out again a navigation later. A miss is cached
// too: a member who has left would otherwise be re-asked for on every page they appear on.
const MEMBER_CACHE_MS = 60_000;
const MEMBER_CACHE_MAX = 2_000;

const memberCache = new Map<string, { member: GuildMember | null; at: number }>();

function cachedMembers(guildId: string, userIds: readonly string[]) {
  const now = Date.now();
  const found: GuildMember[] = [];
  const missing: string[] = [];

  for (const id of userIds) {
    const held = memberCache.get(`${guildId}:${id}`);

    if (held === undefined || now - held.at > MEMBER_CACHE_MS) missing.push(id);
    else if (held.member !== null) found.push(held.member);
  }

  return { found, missing };
}

function rememberMembers(guildId: string, asked: readonly string[], answered: GuildMember[]): void {
  const now = Date.now();
  const byId = new Map(answered.map((member) => [member.id, member]));

  // Oldest first, because Map keeps insertion order and the cap is the only thing stopping a
  // long-lived process from holding every member of every guild an admin has ever paged through.
  for (const key of memberCache.keys()) {
    if (memberCache.size + asked.length <= MEMBER_CACHE_MAX) break;
    memberCache.delete(key);
  }

  for (const id of asked) {
    memberCache.set(`${guildId}:${id}`, { member: byId.get(id) ?? null, at: now });
  }
}

// The same hundred membersQuery slices to in lib/queries.ts, which cannot be imported here: that
// module imports this one.
const MEMBER_IDS_MAX = 100;

export const getGuildMembers = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(
    z.object({
      guildId: z.string().min(1),
      userIds: z.array(z.string().min(1)).max(MEMBER_IDS_MAX),
    }),
  )
  .handler(async ({ data }): Promise<GuildMember[]> => {
    const wanted = [...new Set(data.userIds)];
    const { found, missing } = cachedMembers(data.guildId, wanted);

    if (missing.length === 0) return found;

    const answered = await fetchGuildMembers(env.REST_PROXY_URL, data.guildId, missing);
    rememberMembers(data.guildId, missing, answered);

    return [...found, ...answered];
  });

export const getAntinukeMaintenance = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data }) => api.getMaintenance(data.guildId));

// requireManageGuild: re-arming the breaker early is a security decision, not a read.
export const endAntinukeMaintenance = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(z.object({ guildId: z.string().min(1) }))
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) => api.endMaintenance(data.guildId, stamp.actorId)),
  );

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

/**
 * Post from the settings page. requireManageGuild, not requireGuildAccess: this puts a
 * message in a channel, which is a change to the server rather than a read of it.
 */
export const postModulePanel = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(
    z.object({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
      panelId: z.string().min(1),
    }),
  )
  .handler(({ data, context }) =>
    withAudit(context.session.user.id, (stamp) =>
      api.postPanel(data.guildId, data.moduleId, data.panelId, stamp),
    ),
  );
