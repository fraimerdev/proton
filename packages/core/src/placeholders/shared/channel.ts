import type { PlaceholderDefinitionInput } from '../definitions.ts';
import {
  type PlaceholderValue,
  type ResolvedValue,
  typeOf,
  placeholderValue as v,
} from '../values.ts';
import type { ChannelFacts } from './facts.ts';
import { isSnowflake } from './user.ts';

export const CHANNEL_NAMESPACES = ['channel', 'destination_channel'] as const;

export type ChannelNamespace = (typeof CHANNEL_NAMESPACES)[number];

const GROUPS: Record<ChannelNamespace, string> = {
  channel: 'Channel',
  destination_channel: 'Where it posts',
};

const CHANNEL_KEYS = ['id', 'mention', 'name', 'url', 'category_mention'] as const;

type ChannelKey = (typeof CHANNEL_KEYS)[number];

type Entry = readonly [label: string, description: string, example: PlaceholderValue];

const EXAMPLE_GUILD = '100000000000000001';

const EXAMPLE_CHANNEL = '100000000000000040';

const CHANNEL: Record<ChannelKey, Entry> = {
  id: ['Channel ID', 'Discord channel id', v.text(EXAMPLE_CHANNEL)],
  mention: [
    'Channel',
    'The channel as a clickable mention; its name where mentions cannot be shown',
    v.channel(EXAMPLE_CHANNEL, 'general'),
  ],
  name: ['Channel name', "The channel's name", v.text('general')],
  url: [
    'Channel link',
    'A link that opens the channel',
    v.url(`https://discord.com/channels/${EXAMPLE_GUILD}/${EXAMPLE_CHANNEL}`),
  ],
  category_mention: [
    'Category',
    'The category the channel sits in; empty when it has none',
    v.channel('100000000000000041', 'Community'),
  ],
};

export function channelDefinitions(namespace: ChannelNamespace): PlaceholderDefinitionInput[] {
  return CHANNEL_KEYS.map((key) => {
    const [label, description, example] = CHANNEL[key];
    return {
      key: `${namespace}.${key}`,
      label,
      description,
      group: GROUPS[namespace],
      type: typeOf(example),
      example,
    };
  });
}

const NO_CHANNEL = 'this event has no channel';

const NOT_AN_ID = 'the channel id Proton holds is not a Discord id';

export function buildChannelValues(
  ns: string,
  channel: ChannelFacts | null,
  guildId: string,
): Record<string, ResolvedValue> {
  if (channel === null) {
    return Object.fromEntries(
      CHANNEL_KEYS.map((key) => [`${ns}.${key}`, v.unavailable(NO_CHANNEL)]),
    );
  }

  const { id, name, parentId } = channel;
  const valid = isSnowflake(id);

  const values: Record<ChannelKey, ResolvedValue> = {
    id: v.text(id),
    mention: valid ? v.channel(id, name) : v.failed(NOT_AN_ID),
    name:
      name === undefined
        ? v.unavailable("Proton has not seen this channel's name yet")
        : v.text(name),
    url:
      valid && isSnowflake(guildId)
        ? v.url(`https://discord.com/channels/${guildId}/${id}`)
        : v.failed(NOT_AN_ID),
    category_mention:
      parentId === undefined
        ? v.unavailable('Proton has not seen which category this channel is in')
        : parentId === null
          ? v.notSet()
          : isSnowflake(parentId)
            ? v.channel(parentId)
            : v.failed(NOT_AN_ID),
  };

  return Object.fromEntries(CHANNEL_KEYS.map((key) => [`${ns}.${key}`, values[key]]));
}
