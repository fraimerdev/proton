import type { ChannelState, GuildRole, GuildState } from '@proton/core';
import {
  buildServerValues,
  collectConfigTemplates,
  countableChannels,
  definePlaceholderSurface,
  lookupFrom,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type RenderResult,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_NOW,
  serverDefinitions,
  serverFactsFrom,
  timeDefinitions,
  placeholderValue as v,
  withAvailability,
} from '@proton/core/placeholders';
import { CHANNEL_NAME_MAX, type CounterSource } from './constants.ts';

export const COUNTER_EVENT = 'counters.refresh';

export interface CounterPlaceholderFacts {
  source: CounterSource;
  state: GuildState;
}

export function countFor(source: CounterSource, state: GuildState): number | null {
  switch (source) {
    case 'members':
      return state.memberCount ?? null;
    case 'roles':
      return [...state.roles.keys()].filter((roleId) => roleId !== state.everyoneRoleId).length;
    case 'channels':
      return countableChannels(state.channels.values()).length;
  }
}

const TEXT_TYPES: ReadonlySet<number> = new Set([0, 5]);

const VOICE_TYPES: ReadonlySet<number> = new Set([2, 13]);

function channelsOf(state: GuildState, types: ReadonlySet<number>): number {
  return countableChannels(state.channels.values()).filter(
    (channel) => channel.type !== undefined && types.has(channel.type),
  ).length;
}

const COUNTS_GROUP = 'Counts';

const COUNT_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'counter.count',
    aliases: ['count'],
    label: "This counter's number",
    description: 'The number this counter counts: its members, roles or channels',
    group: COUNTS_GROUP,
    type: 'integer',
    example: v.integer(1204),
  },
  {
    key: 'count.members',
    label: 'Members',
    description: 'How many members the server has',
    group: COUNTS_GROUP,
    type: 'integer',
    example: v.integer(1204),
  },
  {
    key: 'count.roles',
    label: 'Roles',
    description: 'How many roles the server has, not counting @everyone',
    group: COUNTS_GROUP,
    type: 'integer',
    example: v.integer(24),
  },
  {
    key: 'count.channels',
    label: 'Channels',
    description: 'How many channels the server has, not counting categories and threads',
    group: COUNTS_GROUP,
    type: 'integer',
    example: v.integer(40),
  },
  {
    key: 'count.text_channels',
    label: 'Text channels',
    description: 'How many text and announcement channels the server has',
    group: COUNTS_GROUP,
    type: 'integer',
    example: v.integer(28),
  },
  {
    key: 'count.voice_channels',
    label: 'Voice channels',
    description: 'How many voice and stage channels the server has',
    group: COUNTS_GROUP,
    type: 'integer',
    example: v.integer(12),
  },
];

const SERVER_KEYS: ReadonlySet<string> = new Set([
  'server.name',
  'server.boost_count',
  'server.boost_tier',
]);

export const COUNT_KEYS: readonly string[] = Object.freeze([
  ...COUNT_DEFINITIONS.map(({ key }) => key),
  'server.boost_count',
]);

const COUNTER_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  ...COUNT_DEFINITIONS,
  ...serverDefinitions().filter(({ key }) => SERVER_KEYS.has(key)),
  // No event renders these: a clock in a channel name would spend a rename on every refresh.
  ...timeDefinitions().map((definition) => withAvailability(definition, ['none'])),
];

const NO_MEMBER_COUNT =
  'Proton has no member count cached for this server yet; it arrives the next time Proton connects to Discord';

function counted(value: number | null): ResolvedValue {
  return value === null ? v.unavailable(NO_MEMBER_COUNT) : v.integer(value);
}

function counterLookup(facts: CounterPlaceholderFacts): PlaceholderLookup {
  const { source, state } = facts;

  return lookupFrom({
    ...buildServerValues(serverFactsFrom(state, state.guildId)),
    'counter.count': counted(countFor(source, state)),
    'count.members': counted(countFor('members', state)),
    'count.roles': counted(countFor('roles', state)),
    'count.channels': counted(countFor('channels', state)),
    'count.text_channels': v.integer(channelsOf(state, TEXT_TYPES)),
    'count.voice_channels': v.integer(channelsOf(state, VOICE_TYPES)),
  });
}

const SAMPLE_GUILD = '100000000000000001';

function sampleId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, '0')}`;
}

function sampleRoles(): Map<string, GuildRole> {
  const roles = new Map<string, GuildRole>([
    [SAMPLE_GUILD, { id: SAMPLE_GUILD, permissions: 0n, position: 0 }],
  ]);

  for (let index = 1; index <= 24; index += 1) {
    const id = sampleId('100000000000000', 200 + index);
    roles.set(id, { id, permissions: 0n, position: index });
  }

  return roles;
}

function sampleChannel(index: number, type: number): [string, ChannelState] {
  const id = sampleId('100000000000000', 400 + index);
  return [id, { id, parentId: null, type, name: `channel-${index}`, overwrites: [] }];
}

function sampleChannels(): Map<string, ChannelState> {
  return new Map([
    ...Array.from({ length: 28 }, (_, index) => sampleChannel(index, 0)),
    ...Array.from({ length: 12 }, (_, index) => sampleChannel(28 + index, 2)),
    sampleChannel(40, 4),
    sampleChannel(41, 11),
  ]);
}

const SAMPLE_STATE: GuildState = {
  guildId: SAMPLE_GUILD,
  ownerId: '100000000000000002',
  everyoneRoleId: SAMPLE_GUILD,
  roles: sampleRoles(),
  botRoleIds: [],
  channels: sampleChannels(),
  name: 'Proton HQ',
  memberCount: 1204,
  iconHash: null,
  bannerHash: null,
  description: 'Sample server',
  boostCount: 14,
  boostTier: 2,
  updatedAt: SAMPLE_NOW,
};

export const COUNTER_SURFACE = definePlaceholderSurface<CounterPlaceholderFacts>({
  id: 'counters.channel_name',
  module: 'counters',
  label: 'Counter channel name',
  event: COUNTER_EVENT,
  audience: 'public',
  fields: [
    {
      path: 'counters.*.template',
      kind: 'channel_name',
      channel: 'voice',
      label: 'Name template',
      limit: CHANNEL_NAME_MAX,
    },
  ],
  definitions: COUNTER_DEFINITIONS,
  build: counterLookup,
  samples: [
    {
      id: 'member',
      label: 'Sample count: 1,204',
      facts: { source: 'members', state: SAMPLE_STATE },
    },
  ],
});

export const countersTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze({ [COUNTER_SURFACE.id]: COUNTER_SURFACE }),
  collect: (config: unknown) => collectConfigTemplates(config, COUNTER_SURFACE),
});

export function renderCounterName(
  template: string,
  facts: CounterPlaceholderFacts,
  now: number,
): RenderResult {
  return renderTemplate(template, COUNTER_SURFACE.build(facts, { now }), {
    registry: COUNTER_SURFACE.registry,
    field: 'channel_name',
    channel: 'voice',
    event: COUNTER_SURFACE.event,
    audience: COUNTER_SURFACE.audience,
    now,
  });
}
