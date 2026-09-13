import type { QueryClient } from '@tanstack/react-query';
import { channelsQuery, moduleConfigQuery, rolesQuery } from '../queries.ts';

// prefetchQuery: a failed fetch must not fail the loader; ModuleRoute throws it to the shell.
export function loadModule(
  queryClient: QueryClient,
  guildId: string,
  moduleId: string,
  preload: boolean,
  search: unknown,
): Promise<unknown> | undefined {
  const options = moduleConfigQuery(guildId, moduleId);
  const cached = queryClient.getQueryData(options.queryKey) !== undefined;
  const config = queryClient.prefetchQuery(options);

  if (typeof document === 'undefined') {
    return Promise.all([
      config,
      import('./area-prefetch.ts').then(({ prefetchArea }) =>
        prefetchArea(queryClient, guildId, moduleId, search),
      ),
    ]);
  }

  // Cached, the page commits at once; uncached, the route's pending header covers the whole wait.
  return preload || !cached ? config : undefined;
}

/**
 * The guild's channels and roles. Nearly every module page puts a ChannelPicker or a RolePicker on
 * screen, both lists are the same for every module, and both are cached for five minutes — so this
 * is asked once when the server is opened rather than on the first click into each picker.
 *
 * Not awaited by the shell: the page is useful before the pickers are, and a Discord refusal here
 * is already reported by the pickers themselves, naming the permission that is missing.
 */
export function warmGuildShape(queryClient: QueryClient, guildId: string): void {
  void queryClient.prefetchQuery(channelsQuery(guildId));
  void queryClient.prefetchQuery(rolesQuery(guildId));
}
