import {
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
  clipGraphemes,
  collectConfigTemplates,
  collectMessageSites,
  DISCORD_TEXT_LIMITS,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MemberFacts,
  type MessageRender,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  parseTemplate,
  REPLY_ACTION_FIELDS,
  type ResolvedValue,
  renderMessageTemplate,
  renderTemplate,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_SERVER,
  type ServerFacts,
  SHARED_PINGS,
  type SurfaceDiagnostic,
  type SurfaceSample,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
  withAvailability,
} from '@proton/core/placeholders';
import type { SavedMessage } from './config.ts';

export const MESSAGES_POST_EVENT = 'messages.post';

export const MESSAGES_SCHEDULED_EVENT = 'messages.scheduled';

export const MESSAGES_REPLY_EVENT = 'messages.reply';

export interface MessagesPerson {
  user: UserFacts;
  member: MemberFacts | null;
}

export interface MessagesPlaceholderFacts {
  server: ServerFacts | null;
  bot: BotFacts | null;
  destinationChannel: ChannelFacts | null;
  actor: MessagesPerson | null;
  user?: MessagesPerson | null | undefined;
}

const TEMPLATE_PATH = 'templates.*';

function underTemplates(fields: readonly TemplateFieldSpec[]): TemplateFieldSpec[] {
  return fields.map((spec) => ({ ...spec, path: `${TEMPLATE_PATH}.${spec.path}` }));
}

const MESSAGE_FIELDS = underTemplates(MESSAGE_TEMPLATE_FIELDS);

const REPLY_FIELDS = underTemplates(REPLY_ACTION_FIELDS);

const ACTOR_KEYS: ReadonlySet<string> = new Set([
  ...userDefinitions('actor', { member: false }).map(({ key }) => key),
  'actor.nickname',
]);

const ACTOR_EVENTS = [MESSAGES_POST_EVENT, MESSAGES_REPLY_EVENT];

function sharedDefinitions(): PlaceholderDefinitionInput[] {
  return [
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
    ...channelDefinitions('destination_channel'),
    ...userDefinitions('actor', { member: true })
      .filter(({ key }) => ACTOR_KEYS.has(key))
      .map((definition) => withAvailability(definition, ACTOR_EVENTS)),
  ];
}

const NO_ACTOR = 'a scheduled post has no one who ran the command';

const NO_PRESSER = 'only a reply to a button or dropdown press knows who pressed it';

function personValues(
  namespace: 'actor' | 'user',
  person: MessagesPerson | null,
  reason: string,
  now: number,
): Record<string, ResolvedValue> {
  if (person !== null) return buildUserValues(namespace, person.user, person.member, now);

  return Object.fromEntries(
    userDefinitions(namespace, { member: true }).map(({ key }) => [key, v.unavailable(reason)]),
  );
}

function messagesLookup(facts: MessagesPlaceholderFacts, env: BuildEnv): PlaceholderLookup {
  const guildId = facts.server?.id ?? '';

  return lookupFrom({
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
    ...buildChannelValues('destination_channel', facts.destinationChannel, guildId),
    ...personValues('actor', facts.actor, NO_ACTOR, env.now),
    ...personValues('user', facts.user ?? null, NO_PRESSER, env.now),
  });
}

const SAMPLE_CHANNEL: ChannelFacts = {
  id: '100000000000000040',
  name: 'announcements',
  type: 0,
  parentId: null,
};

const POST_SAMPLE: SurfaceSample<MessagesPlaceholderFacts> = {
  id: 'member',
  label: 'Sample: Fraimer posting in #announcements on Proton HQ',
  facts: {
    server: SAMPLE_SERVER,
    bot: SAMPLE_BOT,
    destinationChannel: SAMPLE_CHANNEL,
    actor: SAMPLE_MEMBER,
  },
};

const SCHEDULED_SAMPLE: SurfaceSample<MessagesPlaceholderFacts> = {
  id: 'member',
  label: 'Sample: a scheduled post in #announcements on Proton HQ',
  facts: { ...POST_SAMPLE.facts, actor: null },
};

const REPLY_SAMPLE: SurfaceSample<MessagesPlaceholderFacts> = {
  id: 'member',
  label: 'Sample: Fraimer pressing a button in #announcements',
  facts: { ...POST_SAMPLE.facts, user: SAMPLE_MEMBER },
};

export const MESSAGES_POST_SURFACE: PlaceholderSurface<MessagesPlaceholderFacts> =
  definePlaceholderSurface<MessagesPlaceholderFacts>({
    id: MESSAGES_POST_EVENT,
    module: 'messages',
    label: 'Posted template',
    event: MESSAGES_POST_EVENT,
    audience: 'public',
    fields: MESSAGE_FIELDS,
    definitions: sharedDefinitions(),
    build: messagesLookup,
    samples: [POST_SAMPLE],
    pings: SHARED_PINGS,
  });

export const MESSAGES_SCHEDULED_SURFACE: PlaceholderSurface<MessagesPlaceholderFacts> =
  definePlaceholderSurface<MessagesPlaceholderFacts>({
    id: MESSAGES_SCHEDULED_EVENT,
    module: 'messages',
    label: 'Scheduled template',
    event: MESSAGES_SCHEDULED_EVENT,
    audience: 'public',
    fields: MESSAGE_FIELDS,
    definitions: sharedDefinitions(),
    build: messagesLookup,
    samples: [SCHEDULED_SAMPLE],
    pings: SHARED_PINGS,
  });

// No pings: every reply is sent with allowed_mentions parse [], so a may_ping warning would be false.
export const MESSAGES_REPLY_SURFACE: PlaceholderSurface<MessagesPlaceholderFacts> =
  definePlaceholderSurface<MessagesPlaceholderFacts>({
    id: MESSAGES_REPLY_EVENT,
    module: 'messages',
    label: 'Reply to a press',
    event: MESSAGES_REPLY_EVENT,
    audience: 'public',
    fields: REPLY_FIELDS,
    definitions: [...sharedDefinitions(), ...userDefinitions('user', { member: true })],
    build: messagesLookup,
    samples: [REPLY_SAMPLE],
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function templatesWhere(
  config: unknown,
  keep: (template: Record<string, unknown>) => boolean,
): { templates?: unknown[] } {
  const templates = isRecord(config) ? own(config, 'templates') : undefined;
  if (!Array.isArray(templates)) return {};

  const items: unknown[] = templates;
  return {
    templates: items.map((template) =>
      isRecord(template) && keep(template) ? template : undefined,
    ),
  };
}

function isOptedIn(template: Record<string, unknown>): boolean {
  return own(template, 'placeholders') === true;
}

const REPLY_SITES = { id: MESSAGES_REPLY_SURFACE.id, fields: REPLY_FIELDS };

export const messagesTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze({
    [MESSAGES_POST_SURFACE.id]: MESSAGES_POST_SURFACE,
    [MESSAGES_SCHEDULED_SURFACE.id]: MESSAGES_SCHEDULED_SURFACE,
    [MESSAGES_REPLY_SURFACE.id]: MESSAGES_REPLY_SURFACE,
  }),
  collect: (config: unknown) => {
    const opted = templatesWhere(config, isOptedIn);
    return [
      ...collectConfigTemplates(opted, MESSAGES_POST_SURFACE),
      ...collectConfigTemplates(opted, REPLY_SITES),
    ];
  },
});

export interface TemplateNote {
  path: string;
  label: string;
  diagnostic: SurfaceDiagnostic;
}

export function messagesTemplateNotes(config: unknown): TemplateNote[] {
  const scheduled = templatesWhere(
    config,
    (template) => isOptedIn(template) && isRecord(own(template, 'schedule')),
  );
  const notes: TemplateNote[] = [];

  for (const site of collectConfigTemplates(scheduled, MESSAGES_POST_SURFACE)) {
    for (const token of parseTemplate(site.text, MESSAGES_POST_SURFACE.registry).tokens) {
      if (token.kind !== 'placeholder' || token.canonical === null) continue;
      if (!ACTOR_KEYS.has(token.canonical)) continue;

      const shown = token.modifiers.some(({ name }) => name === 'fallback')
        ? 'shows its fallback'
        : 'is empty';

      notes.push({
        path: site.path,
        label: site.spec.label,
        diagnostic: {
          code: 'unavailable',
          severity: 'warning',
          message: `Scheduled posts have no one who ran the command, so ${token.raw} ${shown} there.`,
          span: token.span,
        },
      });
    }
  }

  return notes;
}

export function messageTexts(message: SavedMessage): string[] {
  return collectMessageSites(message, '').map(({ text }) => text);
}

export function renderSavedMessage(
  message: SavedMessage,
  surface: PlaceholderSurface<MessagesPlaceholderFacts>,
  facts: MessagesPlaceholderFacts,
  now: number,
): MessageRender<SavedMessage> {
  const keys = usedKeys(surface, messageTexts(message), { allowedOnly: true });
  return renderMessageTemplate(message, surface, surface.build(facts, { now, keys }), { now });
}

export type ReplyReport = (code: 'output_truncated', message: string) => void;

export function renderReply(
  text: string,
  lookup: PlaceholderLookup,
  now: number,
  report: ReplyReport,
): string {
  const result = renderTemplate(text, lookup, {
    registry: MESSAGES_REPLY_SURFACE.registry,
    field: 'discord_text',
    event: MESSAGES_REPLY_SURFACE.event,
    audience: MESSAGES_REPLY_SURFACE.audience,
    now,
  });
  const content = clipGraphemes(result.output, DISCORD_TEXT_LIMITS.content);

  if (content.length < result.output.length) {
    report('output_truncated', 'the reply passed 2000 characters, so the end was cut.');
  }
  return content;
}
