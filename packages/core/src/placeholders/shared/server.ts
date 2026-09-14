import type { PlaceholderDefinitionInput } from '../definitions.ts';
import type { PingKind } from '../surface.ts';
import {
  type PlaceholderValue,
  type ResolvedValue,
  typeOf,
  placeholderValue as v,
} from '../values.ts';
import type { ServerFacts } from './facts.ts';
import { cdnImageUrl, isSnowflake, snowflakeTime } from './user.ts';

export const SHARED_PINGS: Readonly<Record<string, PingKind>> = Object.freeze({
  'user.role_mentions': 'roles',
  'server.owner_mention': 'users',
  'actor.role_mentions': 'roles',
  'moderator.role_mentions': 'roles',
  'target.role_mentions': 'roles',
});

export interface GuildStateLike {
  name?: string | undefined;
  memberCount?: number | undefined;
  ownerId?: string | undefined;
  everyoneRoleId?: string | undefined;
  roles: ReadonlyMap<string, unknown>;
  channels: ReadonlyMap<string, { type?: number | undefined }>;
  iconHash?: string | null | undefined;
  bannerHash?: string | null | undefined;
  description?: string | null | undefined;
  boostCount?: number | null | undefined;
  boostTier?: number | undefined;
}

const CATEGORY_TYPE = 4;

const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

export function countableChannels<T extends { type?: number | undefined }>(
  channels: Iterable<T>,
): T[] {
  return [...channels].filter(
    (channel) =>
      channel.type === undefined ||
      (channel.type !== CATEGORY_TYPE && !THREAD_TYPES.has(channel.type)),
  );
}

export function serverFactsFrom(state: GuildStateLike | null, guildId: string): ServerFacts {
  if (state === null) return { id: guildId };

  return {
    id: guildId,
    name: state.name,
    memberCount: state.memberCount,
    ownerId: state.ownerId,
    roleCount: [...state.roles.keys()].filter((roleId) => roleId !== state.everyoneRoleId).length,
    channelCount: countableChannels(state.channels.values()).length,
    iconHash: state.iconHash,
    bannerHash: state.bannerHash,
    description: state.description,
    boostCount: state.boostCount,
    boostTier: state.boostTier,
  };
}

export function guildIconUrl(guildId: string, hash: string, size = 256): string {
  return cdnImageUrl(`icons/${guildId}`, hash, size);
}

export function guildBannerUrl(guildId: string, hash: string, size = 1024): string {
  return cdnImageUrl(`banners/${guildId}`, hash, size);
}

const EXAMPLE_GUILD = '100000000000000001';

const SERVER_KEYS = [
  'id',
  'name',
  'member_count',
  'owner_mention',
  'role_count',
  'channel_count',
  'created_at',
  'icon_url',
  'banner_url',
  'description',
  'boost_count',
  'boost_tier',
] as const;

type ServerKey = (typeof SERVER_KEYS)[number];

type Entry = readonly [label: string, description: string, example: PlaceholderValue];

const SERVER: Record<ServerKey, Entry> = {
  id: ['Server ID', 'Discord server id', v.text(EXAMPLE_GUILD)],
  name: ['Server name', "The server's name", v.text('Proton HQ')],
  member_count: ['Member count', 'How many members the server has', v.integer(1204)],
  owner_mention: [
    'Owner',
    "Mentions the owner. In message text this pings them whenever the message's mention settings allow user pings, which is the default.",
    v.user('100000000000000002', 'Owner'),
  ],
  role_count: [
    'Role count',
    'How many roles the server has, not counting @everyone',
    v.integer(24),
  ],
  channel_count: [
    'Channel count',
    'How many channels the server has, not counting categories and threads',
    v.integer(40),
  ],
  created_at: ['Server created', 'When the server was made', v.datetime(Date.UTC(2021, 4, 1))],
  icon_url: [
    'Server icon',
    "The server's icon image; empty when it has none",
    v.imageUrl(`https://cdn.discordapp.com/icons/${EXAMPLE_GUILD}/0a1b2c3d.png?size=256`),
  ],
  banner_url: [
    'Server banner',
    "The server's banner image; empty when it has none",
    v.imageUrl(`https://cdn.discordapp.com/banners/${EXAMPLE_GUILD}/0a1b2c3d.png?size=1024`),
  ],
  description: [
    'Description',
    "The server's description; empty when it has none",
    v.text('A place for Proton'),
  ],
  boost_count: [
    'Boosts',
    'How many boosts the server has. Refreshes when Discord reports a server change or Proton reconnects.',
    v.integer(14),
  ],
  boost_tier: ['Boost level', "The server's boost level, from 0 to 3", v.integer(2)],
};

export function serverDefinitions(): PlaceholderDefinitionInput[] {
  return SERVER_KEYS.map((key) => {
    const [label, description, example] = SERVER[key];
    return {
      key: `server.${key}`,
      label,
      description,
      group: 'Server',
      type: typeOf(example),
      example,
    };
  });
}

const MISSING = "Proton has not seen this server's details since it last connected";

const NOT_AN_ID = 'the id Proton holds for this server is not a Discord id';

function known<T>(value: T | undefined, make: (value: T) => ResolvedValue): ResolvedValue {
  return value === undefined ? v.unavailable(MISSING) : make(value);
}

function nullable<T>(
  value: T | null | undefined,
  make: (value: T) => ResolvedValue,
): ResolvedValue {
  return value === null ? v.notSet() : known(value, make);
}

function count(value: number): ResolvedValue {
  return Number.isInteger(value)
    ? v.integer(value)
    : v.failed('the count Proton holds is not a whole number');
}

export function buildServerValues(facts: ServerFacts | null): Record<string, ResolvedValue> {
  if (facts === null) {
    return Object.fromEntries(SERVER_KEYS.map((key) => [`server.${key}`, v.unavailable(MISSING)]));
  }

  const { id } = facts;
  const valid = isSnowflake(id);
  const created = snowflakeTime(id);
  const image = (url: (guildId: string, hash: string) => string) => (hash: string) =>
    valid ? v.imageUrl(url(id, hash)) : v.failed(NOT_AN_ID);

  const values: Record<ServerKey, ResolvedValue> = {
    id: v.text(id),
    name: known(facts.name, v.text),
    member_count: known(facts.memberCount, count),
    owner_mention: known(facts.ownerId, (ownerId) =>
      isSnowflake(ownerId)
        ? v.user(ownerId)
        : v.failed('the owner id Proton holds is not a Discord id'),
    ),
    role_count: known(facts.roleCount, count),
    channel_count: known(facts.channelCount, count),
    created_at: created === null ? v.failed(NOT_AN_ID) : v.datetime(created),
    icon_url: nullable(facts.iconHash, image(guildIconUrl)),
    banner_url: nullable(facts.bannerHash, image(guildBannerUrl)),
    description: nullable(facts.description, v.text),
    boost_count: nullable(facts.boostCount, count),
    boost_tier: known(facts.boostTier, count),
  };

  return Object.fromEntries(SERVER_KEYS.map((key) => [`server.${key}`, values[key]]));
}
