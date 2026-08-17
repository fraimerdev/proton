import type { LogCategory, LogEventSpec } from './catalogue.ts';
import type { ServerlogConfig } from './config.ts';

export interface Destination {
  channelId: string;
}

export function resolveDestination(
  config: ServerlogConfig,
  spec: LogEventSpec,
): Destination | null {
  const override = config.events[spec.key];

  if (override?.enabled === false) return null;

  // An explicit `on` beats a category that is off, so "everything off except member bans" is two
  // clicks rather than thirteen.
  if (override?.enabled !== true && !config.categories[spec.category]) return null;

  const channelId =
    override?.channelId || config.categoryChannels[spec.category] || config.defaultChannelId;

  return channelId ? { channelId } : null;
}

export function logChannelIds(config: ServerlogConfig): Set<string> {
  const ids = new Set<string>();

  if (config.defaultChannelId) ids.add(config.defaultChannelId);
  for (const channelId of Object.values(config.categoryChannels)) {
    if (channelId) ids.add(channelId);
  }
  for (const override of Object.values(config.events)) {
    if (override?.channelId) ids.add(override.channelId);
  }

  return ids;
}

export interface IgnoreContext {
  channelId?: string | null | undefined;
  actorId?: string | null | undefined;
  actorRoleIds?: readonly string[] | undefined;
  actorIsBot?: boolean | undefined;
}

export function isIgnored(config: ServerlogConfig, context: IgnoreContext): boolean {
  const channelId = context.channelId ?? null;

  // The destination set is checked before the ignore list, so pointing Server Logs at a busy
  // channel cannot make it log its own posts forever.
  if (channelId && logChannelIds(config).has(channelId)) return true;
  if (channelId && config.ignoredChannelIds.includes(channelId)) return true;

  const actorId = context.actorId ?? null;
  if (actorId && config.ignoredUserIds.includes(actorId)) return true;

  if (config.ignoreBots && context.actorIsBot === true) return true;

  if (context.actorRoleIds?.some((roleId) => config.ignoredRoleIds.includes(roleId))) return true;

  return false;
}

export function categoriesOn(config: ServerlogConfig): LogCategory[] {
  return (Object.keys(config.categories) as LogCategory[]).filter((key) => config.categories[key]);
}
