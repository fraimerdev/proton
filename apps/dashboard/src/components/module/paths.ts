export const MODULE_ROUTE_IDS = [
  'antinuke',
  'antiraid',
  'appeals',
  'automod',
  'backup',
  'branding',
  'cases',
  'counters',
  'giveaways',
  'help',
  'honeypot',
  'joinroles',
  'leveling',
  'logging',
  'messages',
  'moderation',
  'permissions',
  'phishing',
  'ping',
  'polls',
  'reminders',
  'rolemenu',
  'serverlog',
  'starboard',
  'suggestions',
  'tags',
  'tempvc',
  'tickets',
  'verification',
  'welcome',
] as const;

export type ModuleRouteId = (typeof MODULE_ROUTE_IDS)[number];

export type ModulePath = `/dashboard/$guildId/${ModuleRouteId}`;

const ROUTED = new Set<string>(MODULE_ROUTE_IDS);

export function hasModulePage(moduleId: string): moduleId is ModuleRouteId {
  return ROUTED.has(moduleId);
}

/**
 * The typed path for a module's page, or undefined when the API is serving a module this build has
 * no page for. Returning undefined rather than a string is what keeps a link to a route that does
 * not exist from compiling — a new module shipped server-side first shows as unreachable in the
 * list instead of a 404 nobody can explain.
 */
export function modulePath(moduleId: string): ModulePath | undefined {
  return hasModulePage(moduleId) ? (`/dashboard/$guildId/${moduleId}` as ModulePath) : undefined;
}
