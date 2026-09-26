import type { CommandCatalogueView, CommandView, JoinrolesRunKind } from '@proton/core';
import { mutationOptions, type QueryClient, queryOptions } from '@tanstack/react-query';
import { getNameStyleStatus } from '../server/branding.ts';
import {
  ackLostCommandPermissions,
  type CommandUpdateInput,
  getGuildCommands,
  setGuildCommandEnabled,
  updateGuildCommand,
} from '../server/commands.ts';
import { getJoinRolesSync, startJoinRolesSync } from '../server/joinroles.ts';
import {
  getAntinukeMaintenance,
  getGuildChannels,
  getGuildEmojis,
  getGuildMembers,
  getGuildOverview,
  getGuildRoles,
  getModuleConfig,
  getProtonAccount,
  getViewer,
  listGuilds,
  listModules,
  searchMembers,
} from '../server/modules.ts';
import {
  endXpEvent,
  listXpEvents,
  type StartXpEventInput,
  startXpEvent,
} from '../server/xp-events.ts';
import { commandsPollInterval } from './command-sync.ts';
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

// Polled: the window expires on a clock, and a page still saying "suspended" is worse than nothing.
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

export function protonAccountQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.protonAccount(guildId),
    queryFn: () => getProtonAccount({ data: { guildId } }),
    staleTime: STALE.guildShape,
    ...LIVE,
  });
}

export const NAME_STYLE_POLL_MS = 3_000;

export function nameStyleStatusQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.nameStyleStatus(guildId),
    queryFn: () => getNameStyleStatus({ data: { guildId } }),
    staleTime: 0,
    retry: false,
    ...LIVE,
  });
}

export const JOINROLES_SYNC_POLL_MS = 5_000;

export function joinrolesSyncQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.joinrolesSync(guildId),
    queryFn: () => getJoinRolesSync({ data: { guildId } }),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.run ? JOINROLES_SYNC_POLL_MS : false),
    ...LIVE,
  });
}

export function startJoinRolesSyncMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (kind: JoinrolesRunKind) => startJoinRolesSync({ data: { guildId, kind } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.joinrolesSync(guildId) }),
  });
}

const commandsPendingSince = new Map<string, number>();

export function guildCommandsQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.commands(guildId),
    queryFn: () => getGuildCommands({ data: { guildId } }),
    staleTime: STALE.moduleConfig,
    refetchInterval: (query) => {
      if (query.state.data?.sync.state !== 'pending') {
        commandsPendingSince.delete(guildId);
        return false;
      }

      const since = commandsPendingSince.get(guildId) ?? Date.now();
      commandsPendingSince.set(guildId, since);
      return commandsPollInterval('pending', since, Date.now());
    },
    ...LIVE,
  });
}

function storeCommand(queryClient: QueryClient, guildId: string, command: CommandView): void {
  commandsPendingSince.delete(guildId);
  queryClient.setQueryData<CommandCatalogueView>(
    queryKeys.commands(guildId),
    (current) =>
      current && {
        ...current,
        commands: current.commands.map((entry) => (entry.key === command.key ? command : entry)),
      },
  );
}

export function updateGuildCommandMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (input: Omit<CommandUpdateInput, 'guildId'>) =>
      updateGuildCommand({ data: { ...input, guildId } }),
    onSuccess: (result) => {
      if (!result.ok) return;
      storeCommand(queryClient, guildId, result.command);
      void queryClient.invalidateQueries({ queryKey: queryKeys.commands(guildId) });
    },
  });
}

export function setGuildCommandEnabledMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      setGuildCommandEnabled({ data: { guildId, key, enabled } }),
    onSuccess: (command) => storeCommand(queryClient, guildId, command),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.commands(guildId) }),
  });
}

export function ackLostCommandPermissionsMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: () => ackLostCommandPermissions({ data: { guildId } }),
    onSuccess: () =>
      queryClient.setQueryData<CommandCatalogueView>(
        queryKeys.commands(guildId),
        (current) => current && { ...current, lostPermissions: null },
      ),
  });
}

// Discord has no batch member endpoint, so the server reads one member per id up to this ceiling.
export const MEMBER_LOOKUP_MAX = 100;

// Sorted ids under queryKeys.guild: pages share entries, and leaving the server clears them.
export function memberSearchQuery(guildId: string, query: string) {
  return queryOptions({
    queryKey: queryKeys.memberSearch(guildId, query),
    queryFn: () => searchMembers({ data: { guildId, query } }),
    enabled: query.trim().length > 0,
    staleTime: STALE.browse,
  });
}

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

export function xpEventsQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.xpEvents(guildId),
    queryFn: () => listXpEvents({ data: { guildId } }),
    staleTime: STALE.browse,
    refetchInterval: (query) => ((query.state.data?.events.length ?? 0) > 0 ? 30_000 : false),
    ...LIVE,
  });
}

// onSettled, not onSuccess: a start refused for a full server must still refresh the list it was refused against.
export function startXpEventMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (input: Omit<StartXpEventInput, 'guildId'>) =>
      startXpEvent({ data: { ...input, guildId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.xpEvents(guildId) }),
  });
}

export function endXpEventMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (eventId: string) => endXpEvent({ data: { guildId, eventId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.xpEvents(guildId) }),
  });
}
