import {
  aliasFallbacks,
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildChannelValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  type ChannelFacts,
  channelDefinitions,
  collectConfigTemplates,
  collectMessageSites,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_SERVER,
  type ServerFacts,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
  withAliases,
  withAvailability,
} from '@proton/core/placeholders';

export const HONEYPOT_NOTICE_EVENT = 'honeypot.notice';

export const HONEYPOT_DM_EVENT = 'honeypot.dm';

export interface HoneypotNoticeFacts {
  guildId: string;
  consequence: string;
  purge: string;
  caught: number;
  channel: ChannelFacts;
  server: ServerFacts | null;
  bot: BotFacts | null;
}

export interface HoneypotDmFacts {
  action: string;
  guildName: string;
  server: ServerFacts | null;
  user: UserFacts | null;
  bot: BotFacts | null;
  appealUrl?: string | undefined;
  inviteUrl?: string | undefined;
}

const GROUP = 'Honeypot';

const SAMPLE_CONSEQUENCE = 'you are removed from the server and let straight back in';

const SAMPLE_PURGE = ' Everything you posted in the last 7 days is deleted with you.';

const SAMPLE_ACTION = 'removed from the server, and can rejoin straight away';

const CONSEQUENCE: PlaceholderDefinitionInput = {
  key: 'honeypot.consequence',
  aliases: ['consequence'],
  label: 'What happens',
  description: 'What happens to anyone who posts in this channel, in the words the notice uses',
  group: GROUP,
  type: 'markdown',
  example: v.markdown(SAMPLE_CONSEQUENCE),
};

const PURGE: PlaceholderDefinitionInput = {
  key: 'honeypot.purge',
  aliases: ['purge'],
  label: 'Messages deleted',
  description:
    'The sentence saying how far back their messages are deleted; empty when nothing is deleted',
  group: GROUP,
  type: 'markdown',
  example: v.markdown(SAMPLE_PURGE),
};

const CAUGHT: PlaceholderDefinitionInput = {
  key: 'honeypot.caught',
  label: 'Caught',
  description: 'How many people this channel has caught. Updates when someone is caught.',
  group: GROUP,
  type: 'integer',
  example: v.integer(3),
};

const ACTION: PlaceholderDefinitionInput = {
  key: 'honeypot.action',
  aliases: ['action'],
  label: 'What was done',
  description: 'What was done to the member, in the words the direct message uses',
  group: GROUP,
  type: 'markdown',
  example: v.markdown(SAMPLE_ACTION),
};

const APPEAL_URL: PlaceholderDefinitionInput = {
  key: 'honeypot.appeal_url',
  label: 'Appeal link',
  description:
    'Where the member appeals their ban. Empty unless they were banned and an appeal form is picked.',
  group: GROUP,
  type: 'url',
  example: v.url('https://prtn.xyz/appeal/sample'),
  sensitivity: 'member_private',
};

const INVITE_URL: PlaceholderDefinitionInput = {
  key: 'honeypot.invite_url',
  label: 'Rejoin link',
  description: 'The invite behind the Rejoin button. Empty unless the server offers a way back in.',
  group: GROUP,
  type: 'url',
  example: v.url('https://discord.gg/example'),
};

const CLOCK = timeDefinitions().map((definition) =>
  withAvailability(definition, [HONEYPOT_DM_EVENT]),
);

const NOTICE_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  CONSEQUENCE,
  PURGE,
  CAUGHT,
  APPEAL_URL,
  ...serverDefinitions(),
  ...channelDefinitions('channel'),
  ...botDefinitions(),
  ...CLOCK,
];

const DM_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  ACTION,
  APPEAL_URL,
  INVITE_URL,
  ...userDefinitions('user', { member: false }),
  ...serverDefinitions().map((definition) =>
    definition.key === 'server.name' ? withAliases(definition, ['server']) : definition,
  ),
  ...botDefinitions(),
  ...CLOCK,
];

function layoutFields(slot: 'noticeLayout' | 'dmLayout'): TemplateFieldSpec[] {
  return MESSAGE_TEMPLATE_FIELDS.filter(({ path }) => path.startsWith('v2.')).map((spec) => ({
    ...spec,
    path: `${slot}.${spec.path}`,
  }));
}

function noticeLookup(facts: HoneypotNoticeFacts): PlaceholderLookup {
  return lookupFrom({
    'honeypot.consequence': v.markdown(facts.consequence),
    'honeypot.purge': v.markdown(facts.purge),
    'honeypot.caught': v.integer(facts.caught),
    ...buildServerValues(facts.server),
    ...buildChannelValues('channel', facts.channel, facts.guildId),
    ...buildBotValues(facts.bot),
  });
}

function dmLookup(facts: HoneypotDmFacts, env: BuildEnv): PlaceholderLookup {
  return aliasFallbacks(
    lookupFrom({
      'honeypot.action': v.markdown(facts.action),
      'honeypot.appeal_url': facts.appealUrl === undefined ? v.notSet() : v.url(facts.appealUrl),
      'honeypot.invite_url': facts.inviteUrl === undefined ? v.notSet() : v.url(facts.inviteUrl),
      ...buildUserValues('user', facts.user, 'unavailable', env.now),
      ...buildServerValues(facts.server),
      ...buildBotValues(facts.bot),
      ...buildTimeValues(env.now),
    }),
    { server: v.text(facts.guildName) },
  );
}

const SAMPLE_TRAP: ChannelFacts = {
  id: '100000000000000040',
  name: 'do-not-post',
  type: 0,
  parentId: null,
};

const SAMPLE_GUILD_NAME = SAMPLE_SERVER.name ?? 'Proton HQ';

// No SHARED_PINGS: every honeypot send forces allowed_mentions to parse nothing, so may_ping would lie.
export const HONEYPOT_NOTICE_SURFACE: PlaceholderSurface<HoneypotNoticeFacts> =
  definePlaceholderSurface<HoneypotNoticeFacts>({
    id: 'honeypot.notice',
    module: 'honeypot',
    label: 'Warning message',
    event: HONEYPOT_NOTICE_EVENT,
    audience: 'public',
    fields: layoutFields('noticeLayout'),
    definitions: NOTICE_DEFINITIONS,
    build: noticeLookup,
    samples: [
      {
        id: 'member',
        label: `Sample: a trap in ${SAMPLE_GUILD_NAME} that has caught 3`,
        facts: {
          guildId: SAMPLE_SERVER.id,
          consequence: SAMPLE_CONSEQUENCE,
          purge: SAMPLE_PURGE,
          caught: 3,
          channel: SAMPLE_TRAP,
          server: SAMPLE_SERVER,
          bot: SAMPLE_BOT,
        },
      },
    ],
  });

export const HONEYPOT_DM_SURFACE: PlaceholderSurface<HoneypotDmFacts> =
  definePlaceholderSurface<HoneypotDmFacts>({
    id: 'honeypot.dm',
    module: 'honeypot',
    label: 'Direct message',
    event: HONEYPOT_DM_EVENT,
    audience: 'member_private',
    fields: layoutFields('dmLayout'),
    definitions: DM_DEFINITIONS,
    build: dmLookup,
    samples: [
      {
        id: 'member',
        label: `Sample: ${SAMPLE_MEMBER.user.globalName ?? 'a member'} caught in ${SAMPLE_GUILD_NAME}`,
        facts: {
          action: SAMPLE_ACTION,
          guildName: SAMPLE_GUILD_NAME,
          server: SAMPLE_SERVER,
          user: SAMPLE_MEMBER.user,
          bot: SAMPLE_BOT,
        },
      },
    ],
  });

export const honeypotTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze({
    [HONEYPOT_NOTICE_SURFACE.id]: HONEYPOT_NOTICE_SURFACE,
    [HONEYPOT_DM_SURFACE.id]: HONEYPOT_DM_SURFACE,
  }),
  collect: (config: unknown) => [
    ...collectConfigTemplates(config, HONEYPOT_NOTICE_SURFACE),
    ...collectConfigTemplates(config, HONEYPOT_DM_SURFACE),
  ],
});

export function layoutPlaceholderKeys(
  surface: Pick<PlaceholderSurface<unknown>, 'registry' | 'event' | 'audience' | 'fields'>,
  layout: unknown,
): Set<string> {
  const texts = collectMessageSites(layout, '').map(({ text }) => text);
  return usedKeys(surface, texts, { allowedOnly: true });
}

export function usesNamespace(keys: ReadonlySet<string>, namespace: string): boolean {
  return [...keys].some((key) => key.startsWith(`${namespace}.`));
}
