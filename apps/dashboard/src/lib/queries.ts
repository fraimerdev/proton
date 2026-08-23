import { queryOptions } from '@tanstack/react-query';
import {
  getGuildChannels,
  getGuildOverview,
  getGuildRoles,
  getModuleConfig,
  getModuleDescriptors,
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

export function moduleDescriptorsQuery(guildId: string, moduleId: string) {
  return queryOptions({
    queryKey: queryKeys.moduleDescriptors(moduleId),
    queryFn: () => getModuleDescriptors({ data: { guildId, moduleId } }),
    staleTime: STALE.descriptors,
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
