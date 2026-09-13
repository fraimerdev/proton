import { queryOptions } from '@tanstack/react-query';
import {
  getAntinukeMaintenance,
  getGuildChannels,
  getGuildEmojis,
  getGuildMembers,
  getGuildOverview,
  getGuildRoles,
  getModuleConfig,
  getViewer,
  listGuilds,
  listModules,
} from '../server/modules.ts';
import { LIVE, queryKeys, STALE } from './query-keys.ts';

export function sessionQuery() {
  return queryOptions({
    queryKey: queryKeys.session(),
    queryFn: () => listGuilds(),
    staleTime: STALE.session,
    ...LIVE,
  });
}

export function viewerQuery() {
  return queryOptions({
    queryKey: queryKeys.viewer(),
    queryFn: () => getViewer(),
    staleTime: STALE.session,
    // A label, not a gate: a retry holds up every public page's render while the database is down.
    retry: false,
    ...LIVE,
    // Signed out is re-asked on every return, however young: the sign-in happened in another tab.
    refetchOnWindowFocus: (query) => (query.state.data?.signedIn === false ? 'always' : true),
  });
}

export function modulesQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.modules(guildId),
    queryFn: () => listModules({ data: { guildId } }),
    staleTime: STALE.modules,
    ...LIVE,
  });
}

export function guildQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.guildOverview(guildId),
    queryFn: () => getGuildOverview({ data: { guildId } }),
    staleTime: STALE.guildShape,
  });
}

export function moduleConfigQuery(guildId: string, moduleId: string) {
  return queryOptions({
    queryKey: queryKeys.moduleConfig(guildId, moduleId),
    queryFn: () => getModuleConfig({ data: { guildId, moduleId } }),
    staleTime: STALE.moduleConfig,
    ...LIVE,
  });
}

// Polled while a window is open: it expires on a clock, and a page that says "suspended" after
// the breaker re-armed is worse than one that says nothing.
export function maintenanceQuery(guildId: string) {
  return queryOptions({
    queryKey: [...queryKeys.guild(guildId), 'antinuke', 'maintenance'] as const,
    queryFn: () => getAntinukeMaintenance({ data: { guildId } }),
    refetchInterval: 30_000,
    retry: false,
    ...LIVE,
  });
}

export function channelsQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.channels(guildId),
    queryFn: () => getGuildChannels({ data: { guildId } }),
    staleTime: STALE.guildShape,
    ...LIVE,
  });
}

export function rolesQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.roles(guildId),
    queryFn: () => getGuildRoles({ data: { guildId } }),
    staleTime: STALE.guildShape,
    ...LIVE,
  });
}

export function emojisQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.emojis(guildId),
    queryFn: () => getGuildEmojis({ data: { guildId } }),
    staleTime: STALE.guildShape,
    ...LIVE,
  });
}

// Discord has no batch endpoint for a known set of ids, so the server reads one member per id. This
// is the ceiling it accepts, and the number the page says out loud when it is holding more.
export const MEMBER_LOOKUP_MAX = 100;

/**
 * The members behind the snowflakes on one page. Keyed on the ids themselves rather than on the
 * page, because the next page of a case log asks for most of the same accounts — and because
 * react-query hashes the key structurally, so two callers that happen to want the same set share
 * one entry. Sorted and deduplicated here for that reason and no other.
 *
 * Built off queryKeys.guild rather than a key of its own, so leaving the server clears it with
 * everything else the guild owns.
 */
export function membersQuery(guildId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds)].sort().slice(0, MEMBER_LOOKUP_MAX);

  return queryOptions({
    queryKey: [...queryKeys.guild(guildId), 'members', ids] as const,
    queryFn: () => getGuildMembers({ data: { guildId, userIds: ids } }),
    staleTime: STALE.guildShape,
    enabled: ids.length > 0,
    ...LIVE,
  });
}
