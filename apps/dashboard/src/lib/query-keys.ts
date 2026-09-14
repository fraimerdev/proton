export const queryKeys = {
  session: () => ['session'] as const,
  viewer: () => ['viewer'] as const,

  guild: (guildId: string) => ['guild', guildId] as const,
  guildOverview: (guildId: string) => ['guild', guildId, 'overview'] as const,
  modules: (guildId: string) => ['guild', guildId, 'modules'] as const,
  moduleConfig: (guildId: string, moduleId: string) =>
    ['guild', guildId, 'module', moduleId] as const,

  channels: (guildId: string) => ['guild', guildId, 'channels'] as const,
  roles: (guildId: string) => ['guild', guildId, 'roles'] as const,
  emojis: (guildId: string) => ['guild', guildId, 'emojis'] as const,
  protonAccount: (guildId: string) => ['guild', guildId, 'proton-account'] as const,
  nameStyleStatus: (guildId: string) =>
    ['guild', guildId, 'branding', 'name-style-status'] as const,
  xpEvents: (guildId: string) => ['guild', guildId, 'leveling', 'xp-events'] as const,
  view: (guildId: string, viewId: string, search: unknown) =>
    ['guild', guildId, 'view', viewId, search] as const,
};

export const STALE = {
  // Short, because this is the answer to "may they administer this guild": every loader that
  // redirects an unauthorised admin away is really reading a cache entry this old.
  session: 30_000,
  modules: 30_000,
  moduleConfig: 30_000,
  guildShape: 5 * 60_000,
  browse: 15_000,
} as const;

// Spread into any query whose truth lives outside this tab: Discord's own channel and role lists,
// another admin's switch, a moderator's ban. staleTime still throttles it, so a focus only costs
// the queries that have actually aged out. Proton's own guild row changes on a join or a tier
// change and is not worth a request per focus, so it is the one query that opts out.
export const LIVE = { refetchOnWindowFocus: true } as const;
