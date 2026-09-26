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

export const CATEGORY_CONTENTS: Partial<Record<LogCategory, string>> = {
  server: 'Server settings, onboarding, the server guide, command permissions and monetization.',
  channels: 'Channels, threads and channel permissions.',
  roles:
    'Roles created, changed and deleted. Roles given to or taken from members are logged under Members.',
  members: 'Joins, leaves, Membership Screening, nickname changes and roles given or taken.',
  messages:
    'Edits, deletions, bulk deletions and pins. Discord doesn’t send a message’s old text, so it only shows if Logging remembers recent message text.',
  voice:
    'Voice joins and leaves, members moved or disconnected by moderators, and server mutes and deafens.',
  moderation:
    'Bans, unbans, kicks, timeouts, warnings, purges, slowmode and channel locks, done in Discord or through Proton, plus prunes, bots added and user reports.',
  integrations: 'Webhooks and integrations.',
  expressions: 'Emoji, stickers and soundboard sounds.',
  automod: 'Discord’s own AutoMod rules, and the messages and members they act on.',
  proton:
    'Module and command settings, modules and commands turned on or off, Anti-Nuke, Anti-Raid and Honeypot triggers, giveaways, tickets and other actions Proton took.',
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

  return <span className="mono">{id}</span>;
}
