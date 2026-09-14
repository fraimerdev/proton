import type { PlaceholderDefinitionInput } from '../definitions.ts';

export { botDefinitions, buildBotValues, PROTON_SUPPORT_URL } from './bot.ts';
export {
  buildChannelValues,
  CHANNEL_NAMESPACES,
  type ChannelNamespace,
  channelDefinitions,
} from './channel.ts';
export type { PlaceholderEnvironment } from './environment.ts';
export {
  buildEventValues,
  buildTimeValues,
  type EventFacts,
  eventDefinitions,
  timeDefinitions,
} from './event.ts';
export type { BotFacts, ChannelFacts, MemberFacts, ServerFacts, UserFacts } from './facts.ts';
export {
  buildServerValues,
  countableChannels,
  type GuildStateLike,
  guildBannerUrl,
  guildIconUrl,
  SHARED_PINGS,
  serverDefinitions,
  serverFactsFrom,
} from './server.ts';
export {
  buildUserValues,
  USER_NAMESPACES,
  type UserNamespace,
  userDefinitions,
} from './user.ts';

export function withAliases(
  definition: PlaceholderDefinitionInput,
  aliases: readonly string[],
): PlaceholderDefinitionInput {
  return { ...definition, aliases: [...aliases] };
}

export function withAvailability(
  definition: PlaceholderDefinitionInput,
  events: readonly string[],
): PlaceholderDefinitionInput {
  return { ...definition, availability: { ...definition.availability, events: [...events] } };
}
