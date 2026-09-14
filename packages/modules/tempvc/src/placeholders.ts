import {
  buildChannelValues,
  buildServerValues,
  type ChannelFacts,
  collectConfigTemplates,
  definePlaceholderSurface,
  lookupFrom,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type RenderResult,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_SERVER,
  SAMPLE_TEMPVC,
  type ServerFacts,
  type SurfaceSample,
  serverDefinitions,
  userDefinitions,
  placeholderValue as v,
  withAliases,
} from '@proton/core/placeholders';
import { CHANNEL_NAME_MAX } from './constants.ts';

export const TEMPVC_CREATE_EVENT = 'tempvc.create';

export interface TempVcOwner {
  userId: string;
  displayName: string;
  username: string;
  globalName?: string | null | undefined;
}

export interface TempVcNameFacts {
  owner: TempVcOwner;
  hub: ChannelFacts | null;
  server: ServerFacts | null;
}

export const TEMPVC_OWNER_KEYS: readonly string[] = Object.freeze([
  'user.display_name',
  'user.username',
  'user.id',
  'user.global_name',
]);

export const TEMPVC_GUILD_KEYS: readonly string[] = Object.freeze([
  'tempvc.hub_name',
  'tempvc.hub_mention',
  'server.name',
]);

const OWNER_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['user.display_name', ['user', 'displayName']],
  ['user.username', ['username']],
  ['user.id', ['userId']],
  ['user.global_name', []],
]);

const HUB_GROUP = 'Creator channel';

const SAMPLE_HUB = '100000000000000060';

const NAME_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  ...userDefinitions('user', { member: false })
    .filter(({ key }) => OWNER_ALIASES.has(key))
    .map((definition) => withAliases(definition, OWNER_ALIASES.get(definition.key) ?? [])),
  {
    key: 'tempvc.hub_name',
    label: 'Creator channel name',
    description: 'The name of the creator channel they joined',
    group: HUB_GROUP,
    type: 'text',
    example: v.text(SAMPLE_TEMPVC.hubName),
  },
  {
    key: 'tempvc.hub_mention',
    label: 'Creator channel',
    description: 'The creator channel they joined; a channel name shows its name',
    group: HUB_GROUP,
    type: 'mention',
    example: v.channel(SAMPLE_HUB, SAMPLE_TEMPVC.hubName),
  },
  ...serverDefinitions().filter(({ key }) => key === 'server.name'),
];

const NO_GLOBAL_NAME = "Proton did not read this member's display name";

function ownerValues(owner: TempVcOwner): Record<string, ResolvedValue> {
  return {
    'user.display_name': v.text(owner.displayName),
    'user.username': v.text(owner.username),
    'user.id': v.text(owner.userId),
    'user.global_name':
      owner.globalName === undefined
        ? v.unavailable(NO_GLOBAL_NAME)
        : v.text(owner.globalName ?? owner.username),
  };
}

function nameLookup(facts: TempVcNameFacts): PlaceholderLookup {
  const hub = buildChannelValues('hub', facts.hub, facts.server?.id ?? '');
  const server = buildServerValues(facts.server);

  return lookupFrom({
    ...ownerValues(facts.owner),
    'tempvc.hub_name': hub['hub.name'] ?? v.unavailable(),
    'tempvc.hub_mention': hub['hub.mention'] ?? v.unavailable(),
    'server.name': server['server.name'] ?? v.unavailable(),
  });
}

const { user: sampleUser, member: sampleMember } = SAMPLE_TEMPVC.owner;

const SAMPLE: SurfaceSample<TempVcNameFacts> = {
  id: 'tempvc',
  label: `Sample: Fraimer joining ${SAMPLE_TEMPVC.hubName} in Proton HQ`,
  facts: {
    owner: {
      userId: sampleUser.id,
      username: sampleUser.username ?? '',
      globalName: sampleUser.globalName,
      displayName: sampleMember.nick ?? sampleUser.globalName ?? sampleUser.username ?? '',
    },
    hub: { id: SAMPLE_HUB, name: SAMPLE_TEMPVC.hubName, type: 2, parentId: null },
    server: SAMPLE_SERVER,
  },
};

export const TEMPVC_NAME_SURFACE = definePlaceholderSurface<TempVcNameFacts>({
  id: 'tempvc.channel_name',
  module: 'tempvc',
  label: 'Temporary channel name',
  event: TEMPVC_CREATE_EVENT,
  audience: 'public',
  fields: [
    {
      path: 'hubs.*.nameTemplate',
      kind: 'channel_name',
      channel: 'voice',
      label: 'Name template',
      limit: CHANNEL_NAME_MAX,
    },
  ],
  definitions: NAME_DEFINITIONS,
  build: nameLookup,
  samples: [SAMPLE],
});

export const tempvcTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze({ [TEMPVC_NAME_SURFACE.id]: TEMPVC_NAME_SURFACE }),
  collect: (config: unknown) => collectConfigTemplates(config, TEMPVC_NAME_SURFACE),
});

export function renderTempVcName(
  template: string,
  facts: TempVcNameFacts,
  now: number,
): RenderResult {
  const rendered = renderTemplate(template, TEMPVC_NAME_SURFACE.build(facts, { now }), {
    registry: TEMPVC_NAME_SURFACE.registry,
    field: 'channel_name',
    channel: 'voice',
    event: TEMPVC_NAME_SURFACE.event,
    audience: TEMPVC_NAME_SURFACE.audience,
    now,
  });

  if (rendered.output !== '') return rendered;

  // Sliced raw rather than normalised: the legacy renderer fell back to exactly this.
  return { ...rendered, output: facts.owner.displayName.slice(0, CHANNEL_NAME_MAX) };
}
