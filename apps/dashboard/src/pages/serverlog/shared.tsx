import {
  LOG_CATEGORIES,
  LOG_EVENT_KEYS,
  LOG_EVENTS,
  type LogCategory,
  type LogEventSpec,
} from '@proton/module-serverlog/catalogue';
import type { ServerlogConfig } from '@proton/module-serverlog/config';
import type { ReactElement } from 'react';
import { Spinner } from '../../components/ui/feedback.tsx';
import type { GuildChannel } from '../../lib/discord.ts';

export type EventOverrides = ServerlogConfig['events'];
export type EventState = 'follow' | 'on' | 'off';

export const CATEGORY_LABEL: Record<LogCategory, string> = {
  server: 'Server',
  channels: 'Channels',
  roles: 'Roles',
  members: 'Members',
  messages: 'Messages',
  voice: 'Voice',
  moderation: 'Moderation',
  invites: 'Invites',
  integrations: 'Integrations',
  expressions: 'Emoji & stickers',
  events: 'Events & stages',
  automod: 'AutoMod',
  proton: 'Proton',
};

export const CATEGORY_CONTENTS: Record<LogCategory, string> = {
  server: 'Server settings, onboarding, server guide, command permissions and monetization',
  channels: 'Channels, threads and channel permissions',
  roles: 'Roles created, updated and deleted',
  members: 'Joins, leaves, Membership Screening, nicknames and role changes',
  messages: 'Edits, deletions, bulk deletions and pins',
  voice: 'Voice joins and leaves, moves, disconnects, server mute and server deafen',
  moderation: 'Bans, unbans, kicks, prunes, timeouts and bots added',
  invites: 'Invites created and deleted',
  integrations: 'Webhooks and integrations',
  expressions: 'Emoji, stickers and soundboard sounds',
  events: 'Scheduled events and stages',
  automod: 'Discord AutoMod rules and the messages they act on',
  proton:
    'Module settings, modules switched on or off, Proton’s moderation actions, security triggers, giveaways and tickets',
};

export const LOG_SPECS: readonly LogEventSpec[] = LOG_EVENT_KEYS.flatMap((key) => {
  const spec = LOG_EVENTS[key];
  return spec ? [spec] : [];
});

export const KEYS_BY_CATEGORY: ReadonlyMap<LogCategory, readonly string[]> = (() => {
  const byCategory = new Map<LogCategory, string[]>(LOG_CATEGORIES.map((key) => [key, []]));
  for (const spec of LOG_SPECS) byCategory.get(spec.category)?.push(spec.key);
  return byCategory;
})();

export function keysOf(category: LogCategory): readonly string[] {
  return KEYS_BY_CATEGORY.get(category) ?? [];
}

// A copy of serverlog's own resolveDestination: the module exposes no `./routing` subpath to import.
export function destinationOf(
  config: ServerlogConfig,
  key: string,
  category: LogCategory,
): string | null {
  const override = config.events[key];

  if (override?.enabled === false) return null;

  // An explicit `on` beats a category that is off, which is the whole point of the third state.
  if (override?.enabled !== true && !config.categories[category]) return null;

  return (
    override?.channelId || config.categoryChannels[category] || config.defaultChannelId || null
  );
}

export function stateOf(config: ServerlogConfig, key: string): EventState {
  const enabled = config.events[key]?.enabled;
  return enabled === true ? 'on' : enabled === false ? 'off' : 'follow';
}

export function withState(events: EventOverrides, key: string, state: EventState): EventOverrides {
  const next = { ...events };
  const channelId = next[key]?.channelId;
  const routed = channelId !== undefined && channelId !== '';

  if (state === 'follow') {
    if (routed) next[key] = { channelId };
    else delete next[key];
    return next;
  }

  next[key] = routed ? { enabled: state === 'on', channelId } : { enabled: state === 'on' };
  return next;
}

export function withChannel(
  events: EventOverrides,
  key: string,
  channelId: string | null,
): EventOverrides {
  const next = { ...events };
  const enabled = next[key]?.enabled;

  if (channelId === null || channelId === '') {
    if (enabled === undefined) delete next[key];
    else next[key] = { enabled };
    return next;
  }

  next[key] = enabled === undefined ? { channelId } : { enabled, channelId };
  return next;
}

export function bulkFollow(events: EventOverrides, keys: Iterable<string>): EventOverrides {
  const next = { ...events };

  for (const key of keys) {
    const channelId = next[key]?.channelId;
    if (channelId !== undefined && channelId !== '') next[key] = { channelId };
    else delete next[key];
  }

  return next;
}

export function bulkUnroute(events: EventOverrides, keys: Iterable<string>): EventOverrides {
  const next = { ...events };

  for (const key of keys) {
    const enabled = next[key]?.enabled;
    if (enabled === undefined) delete next[key];
    else next[key] = { enabled };
  }

  return next;
}

export function bulkRoute(
  events: EventOverrides,
  keys: Iterable<string>,
  channelId: string,
): EventOverrides {
  const next = { ...events };

  for (const key of keys) {
    const enabled = next[key]?.enabled;
    next[key] = enabled === undefined ? { channelId } : { enabled, channelId };
  }

  return next;
}

export function bulkReset(events: EventOverrides, keys: Iterable<string>): EventOverrides {
  const next = { ...events };
  for (const key of keys) delete next[key];
  return next;
}

export interface ChannelIndex {
  byId: ReadonlyMap<string, GuildChannel>;
  pending: boolean;
}

export function ChannelRef({ id, channels }: { id: string; channels: ChannelIndex }): ReactElement {
  const channel = channels.byId.get(id);
  if (channel) return <span>#{channel.name}</span>;

  if (channels.pending) return <Spinner label="Loading channel" />;

  return (
    <span className="mono" title="Proton cannot find this channel. It may have been deleted.">
      {id}
    </span>
  );
}
