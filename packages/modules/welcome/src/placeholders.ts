import {
  aliasFallbacks,
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildChannelValues,
  buildEventValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  type ChannelFacts,
  channelDefinitions,
  collectConfigTemplates,
  collectMessageSites,
  definePlaceholderSurface,
  eventDefinitions,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MemberFacts,
  type MessageRender,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  renderMessageTemplate,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type ServerFacts,
  SHARED_PINGS,
  type SurfaceSample,
  serverDefinitions,
  timeDefinitions,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
  withAliases,
  withAvailability,
} from '@proton/core/placeholders';
import type { GreetingMessage } from './config.ts';

export type GreetingOccasion = 'join' | 'leave' | 'boost';

export interface GreetingPlaceholderFacts {
  user: UserFacts;
  member: MemberFacts | 'unavailable';
  server: ServerFacts | null;
  channel?: ChannelFacts | undefined;
  destinationChannel: ChannelFacts;
  bot: BotFacts | null;
  eventId: string;
  occurredAt: number;
}

const CONFIG_KEYS: Readonly<Record<GreetingOccasion, string>> = {
  join: 'welcomeMessage',
  leave: 'goodbyeMessage',
  boost: 'boostMessage',
};

const OCCASIONS: Readonly<Record<GreetingOccasion, { label: string; caption: string }>> = {
  join: { label: 'Welcome message', caption: 'Sample: Fraimer joining Proton HQ' },
  leave: { label: 'Goodbye message', caption: 'Sample: Fraimer leaving Proton HQ' },
  boost: { label: 'Boost message', caption: 'Sample: Fraimer boosting Proton HQ' },
};

const MEMBER_EVENTS = ['welcome.join', 'welcome.boost'];

const ACCOUNT_KEYS: ReadonlySet<string> = new Set(
  userDefinitions('user', { member: false }).map(({ key }) => key),
);

function greetingDefinitions(occasion: GreetingOccasion): PlaceholderDefinitionInput[] {
  const aliases = new Map<string, readonly string[]>([
    ['user.mention', ['user']],
    [occasion === 'boost' ? 'user.display_name' : 'user.global_name', ['username']],
    ['server.name', ['server']],
    ['server.member_count', ['memberCount']],
  ]);

  return [
    ...userDefinitions('user', { member: true }).map((definition) =>
      ACCOUNT_KEYS.has(definition.key) ? definition : withAvailability(definition, MEMBER_EVENTS),
    ),
    ...serverDefinitions(),
    ...channelDefinitions('destination_channel'),
    ...(occasion === 'boost' ? channelDefinitions('channel') : []),
    ...botDefinitions(),
    ...timeDefinitions(),
    ...eventDefinitions().filter(({ key }) => key === 'event.created_at'),
  ].map((definition) => {
    const named = aliases.get(definition.key);
    return named === undefined ? definition : withAliases(definition, named);
  });
}

const LEGACY_FALLBACKS = {
  username: v.text('someone'),
  server: v.text('this server'),
  memberCount: v.integer(0),
};

function greetingLookup(facts: GreetingPlaceholderFacts, env: BuildEnv): PlaceholderLookup {
  const guildId = facts.server?.id ?? '';

  return aliasFallbacks(
    lookupFrom({
      ...buildUserValues('user', facts.user, facts.member, env.now),
      ...buildServerValues(facts.server),
      ...buildChannelValues('destination_channel', facts.destinationChannel, guildId),
      ...buildChannelValues('channel', facts.channel ?? null, guildId),
      ...buildBotValues(facts.bot),
      ...buildTimeValues(env.now),
      ...buildEventValues({ id: facts.eventId, occurredAt: facts.occurredAt }),
    }),
    LEGACY_FALLBACKS,
  );
}

const SAMPLE_CHANNEL: ChannelFacts = {
  id: '100000000000000040',
  name: 'welcome',
  type: 0,
  parentId: null,
};

function sampleFor(occasion: GreetingOccasion): SurfaceSample<GreetingPlaceholderFacts> {
  const { member } = SAMPLE_MEMBER;

  return {
    id: 'member',
    label: OCCASIONS[occasion].caption,
    facts: {
      user: SAMPLE_MEMBER.user,
      member:
        occasion === 'leave'
          ? 'unavailable'
          : occasion === 'boost'
            ? { ...member, premiumSince: new Date(SAMPLE_NOW).toISOString() }
            : member,
      server: SAMPLE_SERVER,
      ...(occasion === 'boost' ? { channel: SAMPLE_CHANNEL } : {}),
      destinationChannel: SAMPLE_CHANNEL,
      bot: SAMPLE_BOT,
      eventId: '01J8Z3K5N2V7Q4R6T8W0X2Y4Z6',
      occurredAt: SAMPLE_NOW,
    },
  };
}

function defineGreetingSurface(
  occasion: GreetingOccasion,
): PlaceholderSurface<GreetingPlaceholderFacts> {
  const base = CONFIG_KEYS[occasion];

  return definePlaceholderSurface<GreetingPlaceholderFacts>({
    id: `welcome.${occasion}`,
    module: 'welcome',
    label: OCCASIONS[occasion].label,
    event: `welcome.${occasion}`,
    audience: 'public',
    fields: MESSAGE_TEMPLATE_FIELDS.map((spec) => ({ ...spec, path: `${base}.${spec.path}` })),
    definitions: greetingDefinitions(occasion),
    build: greetingLookup,
    samples: [sampleFor(occasion)],
    pings: SHARED_PINGS,
  });
}

export const WELCOME_JOIN_SURFACE = defineGreetingSurface('join');

export const WELCOME_LEAVE_SURFACE = defineGreetingSurface('leave');

export const WELCOME_BOOST_SURFACE = defineGreetingSurface('boost');

const SURFACE_LIST = [WELCOME_JOIN_SURFACE, WELCOME_LEAVE_SURFACE, WELCOME_BOOST_SURFACE] as const;

const BASE_PATHS: ReadonlyMap<string, string> = new Map([
  [WELCOME_JOIN_SURFACE.id, CONFIG_KEYS.join],
  [WELCOME_LEAVE_SURFACE.id, CONFIG_KEYS.leave],
  [WELCOME_BOOST_SURFACE.id, CONFIG_KEYS.boost],
]);

export const welcomeTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze(Object.fromEntries(SURFACE_LIST.map((surface) => [surface.id, surface]))),
  collect: (config: unknown) =>
    SURFACE_LIST.flatMap((surface) => collectConfigTemplates(config, surface)),
});

export function greetingTemplates(message: GreetingMessage): string[] {
  return collectMessageSites(message, '').map(({ text }) => text);
}

export function renderGreetingMessage(
  message: GreetingMessage,
  surface: PlaceholderSurface<GreetingPlaceholderFacts>,
  facts: GreetingPlaceholderFacts,
  now: number,
): MessageRender<GreetingMessage> {
  const keys = usedKeys(surface, greetingTemplates(message), { allowedOnly: true });

  return renderMessageTemplate(message, surface, surface.build(facts, { now, keys }), {
    now,
    basePath: BASE_PATHS.get(surface.id) ?? '',
  });
}
