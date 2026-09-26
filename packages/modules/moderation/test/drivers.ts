import {
  type ActionKind,
  type AuditEntry,
  auditEntrySchema,
  type EventType,
  moderationPunishmentExpiredSchema,
  moderationReportActionRequestedSchema,
  moderationReportResolvedSchema,
  moderationReportSubmittedSchema,
  newCaseId,
  newId,
  OptionType,
  type ProtonActionExecuted,
  type ProtonConfigChanged,
  type ProtonEvent,
  protonActionExecutedSchema,
  protonConfigChangedSchema,
  type RawOption,
} from '@proton/core';
import { type DispatchName, dispatch } from '@proton/fixtures';
import { ApplicationCommandType, ComponentType, InteractionType } from 'discord-api-types/v10';
import type { z } from 'zod';
import {
  ABOVE_BOT,
  APPLICATION_ID,
  BOT,
  BOT_PERMISSIONS,
  CHANNEL,
  dmChannelFor,
  GUILD,
  LEFT_MEMBER,
  MEMBER,
  MESSAGE,
  MODERATOR,
  OWNER,
  REPORTER,
  rolesHeldBy,
} from './harness.ts';

export type RawObject = Record<string, unknown>;

export interface RawResolved {
  users?: Record<string, RawObject>;
  members?: Record<string, RawObject>;
  messages?: Record<string, RawObject>;
  attachments?: Record<string, RawObject>;
}

const COMMAND_ID = '1250000000000000100';
const JOINED_AT = Date.UTC(2026, 0, 4, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const NAMES: Record<string, string> = {
  [MODERATOR]: 'moderator',
  [MEMBER]: 'member',
  [REPORTER]: 'reporter',
  [OWNER]: 'owner',
  [ABOVE_BOT]: 'abovebot',
  [LEFT_MEMBER]: 'leaver',
  [BOT]: 'proton',
};

let sequence = 0n;

export function snowflake(): string {
  sequence += 1n;
  return String(1_500_000_000_000_100_000n + sequence);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export interface RawUserOptions {
  username?: string;
  globalName?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

export function rawUser(userId: string, options: RawUserOptions = {}): RawObject {
  const username = options.username ?? NAMES[userId] ?? `user${userId.slice(-4)}`;

  return {
    id: userId,
    username,
    discriminator: '0',
    global_name: options.globalName === undefined ? username : options.globalName,
    avatar: options.avatar ?? null,
    bot: options.bot ?? false,
  };
}

export interface RawMemberOptions {
  roleIds?: string[];
  nick?: string | null;
  permissions?: bigint;
  joinedAt?: number;
  timeoutUntil?: number | null;
  pending?: boolean;
}

export function rawMember(options: RawMemberOptions = {}): RawObject {
  return {
    roles: options.roleIds ?? [],
    nick: options.nick ?? null,
    joined_at: iso(options.joinedAt ?? JOINED_AT),
    premium_since: null,
    pending: options.pending ?? false,
    flags: 0,
    ...(options.permissions === undefined ? {} : { permissions: String(options.permissions) }),
    communication_disabled_until: options.timeoutUntil ? iso(options.timeoutUntil) : null,
  };
}

export interface RawAttachmentOptions {
  id?: string;
  filename?: string;
  contentType?: string | null;
  size?: number;
  expiresAt?: number;
  ephemeral?: boolean;
  width?: number;
  height?: number;
}

export function rawAttachment(options: RawAttachmentOptions = {}): RawObject {
  const id = options.id ?? snowflake();
  const filename = options.filename ?? 'screenshot.png';
  const ex = Math.floor((options.expiresAt ?? Date.now() + DAY) / 1000).toString(16);
  const folder = options.ephemeral ? 'ephemeral-attachments' : 'attachments';
  const path = `${folder}/${CHANNEL}/${id}/${filename}?ex=${ex}&is=${ex}&hm=${'0'.repeat(64)}&`;

  return {
    id,
    filename,
    size: options.size ?? 1024,
    url: `https://cdn.discordapp.com/${path}`,
    proxy_url: `https://media.discordapp.net/${path}`,
    content_type: options.contentType === undefined ? 'image/png' : options.contentType,
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.ephemeral ? { ephemeral: true } : {}),
  };
}

export interface RawMessageOptions {
  id?: string;
  channelId?: string;
  authorId?: string;
  author?: RawObject | null;
  content?: string;
  attachments?: RawObject[];
  embeds?: RawObject[];
  webhookId?: string;
  type?: number;
  flags?: number;
  at?: number;
  editedAt?: number;
  forwardedContent?: string;
}

export function rawMessage(options: RawMessageOptions = {}): RawObject {
  const at = options.at ?? Date.now();

  return {
    id: options.id ?? MESSAGE,
    channel_id: options.channelId ?? CHANNEL,
    type: options.type ?? 0,
    author: options.author === undefined ? rawUser(options.authorId ?? MEMBER) : options.author,
    content: options.content ?? (options.forwardedContent === undefined ? 'hello' : ''),
    timestamp: iso(at),
    edited_timestamp: options.editedAt === undefined ? null : iso(options.editedAt),
    flags: options.flags ?? 0,
    tts: false,
    pinned: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    components: [],
    embeds: options.embeds ?? [],
    attachments: options.attachments ?? [],
    ...(options.webhookId ? { webhook_id: options.webhookId } : {}),
    ...(options.forwardedContent === undefined
      ? {}
      : {
          message_reference: { type: 1, channel_id: CHANNEL, message_id: snowflake() },
          message_snapshots: [
            {
              message: {
                type: 0,
                content: options.forwardedContent,
                embeds: [],
                attachments: [],
                timestamp: iso(at),
                edited_timestamp: null,
                flags: 0,
              },
            },
          ],
        }),
  };
}

export interface InteractionOptions {
  userId?: string;
  roleIds?: string[];
  permissions?: bigint;
  nick?: string | null;
  guildId?: string | null;
  channelId?: string;
  appPermissions?: bigint;
  interactionId?: string;
  token?: string;
  eventId?: string;
  at?: number;
}

function guildOf(options: { guildId?: string | null }): string | null {
  return options.guildId === undefined ? GUILD : options.guildId;
}

function channelOf(options: InteractionOptions): string {
  if (options.channelId) return options.channelId;
  return guildOf(options) === null ? dmChannelFor(options.userId ?? MODERATOR) : CHANNEL;
}

function interactionPayload(
  type: InteractionType,
  options: InteractionOptions,
  extra: RawObject,
): RawObject {
  const interactionId = options.interactionId ?? snowflake();
  const userId = options.userId ?? MODERATOR;
  const guildId = guildOf(options);
  const channelId = channelOf(options);
  const user = rawUser(userId);

  return {
    id: interactionId,
    application_id: APPLICATION_ID,
    type,
    token: options.token ?? `token-${interactionId}`,
    version: 1,
    channel_id: channelId,
    channel: { id: channelId, type: guildId === null ? 1 : 0 },
    app_permissions: String(options.appPermissions ?? BOT_PERMISSIONS),
    locale: 'en-US',
    ...(guildId === null
      ? { context: 1, user }
      : {
          guild_id: guildId,
          guild_locale: 'en-US',
          context: 0,
          member: {
            user,
            ...rawMember({
              roleIds: options.roleIds ?? rolesHeldBy(userId),
              nick: options.nick ?? null,
              permissions: options.permissions ?? 0n,
            }),
          },
        }),
    ...extra,
  };
}

function interactionEvent(
  type: EventType,
  payload: RawObject,
  options: InteractionOptions,
): ProtonEvent {
  return {
    id: options.eventId ?? `${type}:${String(payload.id)}`,
    type,
    guildId: guildOf(options),
    occurredAt: options.at ?? Date.now(),
    payload,
  };
}

export interface ComponentOptions extends InteractionOptions {
  componentType?: number;
  values?: string[];
  resolved?: RawResolved;
  messageId?: string;
  messageFlags?: number;
}

export function componentEvent(customId: string, options: ComponentOptions = {}): ProtonEvent {
  const payload = interactionPayload(InteractionType.MessageComponent, options, {
    data: {
      custom_id: customId,
      component_type: options.componentType ?? ComponentType.Button,
      ...(options.values ? { values: options.values } : {}),
      ...(options.resolved ? { resolved: options.resolved } : {}),
    },
    message: {
      id: options.messageId ?? MESSAGE,
      channel_id: channelOf(options),
      type: 0,
      content: '',
      flags: options.messageFlags ?? 0,
    },
  });

  return interactionEvent('interaction.component', payload, options);
}

export function pressEvent(customId: string, options: ComponentOptions = {}): ProtonEvent {
  return componentEvent(customId, { ...options, componentType: ComponentType.Button });
}

export function selectEvent(
  customId: string,
  values: string[],
  options: ComponentOptions = {},
): ProtonEvent {
  return componentEvent(customId, {
    componentType: ComponentType.StringSelect,
    ...options,
    values,
  });
}

export interface ModalAnswers {
  text?: Record<string, string>;
  selects?: Record<string, string[]>;
  files?: Record<string, RawObject[]>;
  checks?: Record<string, boolean>;
}

export interface ModalOptions extends InteractionOptions {
  messageId?: string;
  messageFlags?: number;
}

export function modalEvent(
  customId: string,
  answers: ModalAnswers = {},
  options: ModalOptions = {},
): ProtonEvent {
  const files = Object.entries(answers.files ?? {});

  const components: RawObject[] = [
    ...Object.entries(answers.text ?? {}).map(([id, value]) => ({
      type: ComponentType.TextInput,
      custom_id: id,
      value,
    })),
    ...Object.entries(answers.selects ?? {}).map(([id, values]) => ({
      type: ComponentType.StringSelect,
      custom_id: id,
      values,
    })),
    ...files.map(([id, uploads]) => ({
      type: ComponentType.FileUpload,
      custom_id: id,
      values: uploads.map((upload) => String(upload.id)),
    })),
    ...Object.entries(answers.checks ?? {}).map(([id, value]) => ({
      type: ComponentType.Checkbox,
      custom_id: id,
      value,
    })),
  ];

  const attachments = Object.fromEntries(
    files.flatMap(([, uploads]) => uploads).map((upload) => [String(upload.id), upload]),
  );

  const payload = interactionPayload(InteractionType.ModalSubmit, options, {
    data: {
      custom_id: customId,
      components: components.map((component, index) => ({
        type: ComponentType.Label,
        id: index * 2 + 1,
        component: { id: index * 2 + 2, ...component },
      })),
      ...(files.length > 0 ? { resolved: { attachments } } : {}),
    },
    ...(options.messageId
      ? {
          message: {
            id: options.messageId,
            channel_id: channelOf(options),
            type: 0,
            content: '',
            flags: options.messageFlags ?? 0,
          },
        }
      : {}),
  });

  return interactionEvent('interaction.modal', payload, options);
}

function userOptionValues(options: readonly RawOption[]): string[] {
  return options.flatMap((option) => [
    ...(option.type === OptionType.User && typeof option.value === 'string' ? [option.value] : []),
    ...userOptionValues(option.options ?? []),
  ]);
}

function memberOf(userId: string): RawObject | null {
  return userId === LEFT_MEMBER ? null : rawMember({ roleIds: rolesHeldBy(userId) });
}

function withResolved(resolved: RawResolved): RawObject {
  const present = Object.entries(resolved).filter(([, entries]) => Object.keys(entries).length > 0);
  return present.length > 0 ? { resolved: Object.fromEntries(present) } : {};
}

export interface SlashOptions extends InteractionOptions {
  resolved?: RawResolved;
}

export function slashEvent(
  name: string,
  options: RawOption[] = [],
  settings: SlashOptions = {},
): ProtonEvent {
  const users: Record<string, RawObject> = {};
  const members: Record<string, RawObject> = {};

  for (const userId of userOptionValues(options)) {
    users[userId] = rawUser(userId);
    const member = memberOf(userId);
    if (member) members[userId] = member;
  }

  const payload = interactionPayload(InteractionType.ApplicationCommand, settings, {
    data: {
      id: COMMAND_ID,
      name,
      type: ApplicationCommandType.ChatInput,
      options,
      ...withResolved({
        ...settings.resolved,
        users: { ...users, ...settings.resolved?.users },
        members: { ...members, ...settings.resolved?.members },
      }),
    },
  });

  return interactionEvent('interaction.command', payload, settings);
}

export interface UserMenuOptions extends InteractionOptions {
  user?: RawObject;
  member?: RawObject | null;
}

export function userMenuEvent(
  name: string,
  targetId: string,
  options: UserMenuOptions = {},
): ProtonEvent {
  const member = options.member === undefined ? memberOf(targetId) : options.member;

  const payload = interactionPayload(InteractionType.ApplicationCommand, options, {
    data: {
      id: COMMAND_ID,
      name,
      type: ApplicationCommandType.User,
      target_id: targetId,
      resolved: {
        users: { [targetId]: options.user ?? rawUser(targetId) },
        ...(member ? { members: { [targetId]: member } } : {}),
      },
    },
  });

  return interactionEvent('interaction.command', payload, options);
}

export interface MessageMenuOptions extends InteractionOptions {
  message?: RawObject;
}

export function messageMenuEvent(name: string, options: MessageMenuOptions = {}): ProtonEvent {
  const message = options.message ?? rawMessage({ channelId: channelOf(options) });
  const targetId = String(message.id);

  const payload = interactionPayload(InteractionType.ApplicationCommand, options, {
    data: {
      id: COMMAND_ID,
      name,
      type: ApplicationCommandType.Message,
      target_id: targetId,
      resolved: { messages: { [targetId]: message } },
    },
  });

  return interactionEvent('interaction.command', payload, options);
}

export interface AutocompleteOptions extends InteractionOptions {
  subcommand?: string;
  options?: RawOption[];
}

export function autocompleteEvent(
  command: string,
  focused: { name: string; value: string; type?: number },
  settings: AutocompleteOptions = {},
): ProtonEvent {
  const leaf = [
    ...(settings.options ?? []),
    {
      name: focused.name,
      type: focused.type ?? OptionType.String,
      value: focused.value,
      focused: true,
    },
  ];

  const payload = interactionPayload(InteractionType.ApplicationCommandAutocomplete, settings, {
    data: {
      id: COMMAND_ID,
      name: command,
      type: ApplicationCommandType.ChatInput,
      options: settings.subcommand
        ? [{ name: settings.subcommand, type: OptionType.Subcommand, options: leaf }]
        : leaf,
    },
  });

  return interactionEvent('interaction.autocomplete', payload, settings);
}

export interface ReactionOptions {
  userId?: string;
  roleIds?: string[];
  bot?: boolean;
  withMember?: boolean;
  guildId?: string | null;
  channelId?: string;
  messageId?: string;
  messageAuthorId?: string | null;
  emoji?: { id: string | null; name: string | null; animated?: boolean };
  removed?: boolean;
  eventId?: string;
  at?: number;
}

export function reactionEvent(options: ReactionOptions = {}): ProtonEvent {
  const userId = options.userId ?? REPORTER;
  const guildId = guildOf(options);
  const channelId = options.channelId ?? CHANNEL;
  const messageId = options.messageId ?? MESSAGE;
  const emoji = options.emoji ?? { id: null, name: '🚩' };
  const type: EventType = options.removed ? 'reaction.removed' : 'reaction.added';

  return {
    id:
      options.eventId ??
      `${type}:${channelId}:${messageId}:${userId}:${emoji.id ?? emoji.name}:${snowflake()}`,
    type,
    guildId,
    occurredAt: options.at ?? Date.now(),
    payload: {
      user_id: userId,
      channel_id: channelId,
      message_id: messageId,
      ...(guildId === null ? {} : { guild_id: guildId }),
      ...(options.messageAuthorId === null
        ? {}
        : { message_author_id: options.messageAuthorId ?? MEMBER }),
      emoji,
      burst: false,
      type: 0,
      ...(guildId !== null && options.withMember !== false
        ? {
            member: {
              user: rawUser(userId, { bot: options.bot ?? false }),
              ...rawMember({ roleIds: options.roleIds ?? rolesHeldBy(userId) }),
            },
          }
        : {}),
    },
  };
}

export interface EventOptions {
  guildId?: string | null;
  id?: string;
  at?: number;
}

export function protonEvent(
  type: EventType,
  payload: unknown,
  options: EventOptions = {},
): ProtonEvent {
  return {
    id: options.id ?? `${type}:${newId()}`,
    type,
    guildId: guildOf(options),
    occurredAt: options.at ?? Date.now(),
    payload,
  };
}

export function actionExecutedEvent(
  input: Partial<ProtonActionExecuted> & { kind: ActionKind },
  options: EventOptions = {},
): ProtonEvent {
  const payload = protonActionExecutedSchema.parse({
    caseId: newCaseId(),
    guildId: GUILD,
    moduleId: 'moderation',
    actorId: MODERATOR,
    targetId: MEMBER,
    ...input,
  });

  return protonEvent('proton.action_executed', payload, {
    id: `proton.action_executed:${payload.caseId}`,
    ...options,
  });
}

export function auditEntryEvent(
  input: Partial<AuditEntry> & Pick<AuditEntry, 'actionType'>,
  options: EventOptions = {},
): ProtonEvent {
  const payload = auditEntrySchema.parse({
    entryId: snowflake(),
    guildId: GUILD,
    actorId: MODERATOR,
    targetId: MEMBER,
    reason: null,
    ...input,
  });

  return protonEvent('audit.entry', payload, { id: `audit.entry:${payload.entryId}`, ...options });
}

export interface MemberJoinOptions extends RawMemberOptions, EventOptions {
  bot?: boolean;
}

export function memberJoinedEvent(userId: string, options: MemberJoinOptions = {}): ProtonEvent {
  const joinedAt = options.joinedAt ?? options.at ?? Date.now();
  const guildId = guildOf(options) ?? GUILD;

  return protonEvent(
    'member.joined',
    {
      guild_id: guildId,
      user: rawUser(userId, { bot: options.bot ?? false }),
      ...rawMember({ roleIds: [], ...options, joinedAt }),
    },
    { id: `member.joined:${guildId}:${userId}:${iso(joinedAt)}`, ...options },
  );
}

export interface MessageEventOptions extends EventOptions {
  roleIds?: string[];
}

export function messageCreatedEvent(
  message: RawObject = rawMessage(),
  options: MessageEventOptions = {},
): ProtonEvent {
  const guildId = guildOf(options);
  const author = message.author as RawObject | null | undefined;
  const authorId = typeof author?.id === 'string' ? author.id : MEMBER;

  return protonEvent(
    'message.created',
    {
      ...message,
      ...(guildId === null
        ? {}
        : {
            guild_id: guildId,
            member: rawMember({ roleIds: options.roleIds ?? rolesHeldBy(authorId) }),
          }),
    },
    { id: `message.created:${String(message.id)}`, ...options },
  );
}

export function messageDeletedEvent(
  channelId: string = CHANNEL,
  messageId: string = MESSAGE,
  options: EventOptions = {},
): ProtonEvent {
  const guildId = guildOf(options);

  return protonEvent(
    'message.deleted',
    { id: messageId, channel_id: channelId, ...(guildId === null ? {} : { guild_id: guildId }) },
    { id: `message.deleted:${channelId}:${messageId}`, ...options },
  );
}

export function guildAvailableEvent(options: EventOptions = {}): ProtonEvent {
  const guildId = guildOf(options) ?? GUILD;

  return protonEvent(
    'guild.available',
    { id: guildId, name: 'Proton test server', owner_id: OWNER, unavailable: false },
    { id: `guild.available:${guildId}:${snowflake()}`, ...options },
  );
}

export function configChangedEvent(
  input: Partial<ProtonConfigChanged> = {},
  options: EventOptions = {},
): ProtonEvent {
  const payload = protonConfigChangedSchema.parse({
    auditId: newId(),
    guildId: GUILD,
    moduleId: 'moderation',
    actorId: OWNER,
    source: 'dashboard',
    enabledBefore: true,
    enabledAfter: true,
    ...input,
  });

  return protonEvent('proton.config_changed', payload, {
    id: `proton.config_changed:${payload.auditId}`,
    ...options,
  });
}

const MODERATION_EVENT_SCHEMAS = {
  'moderation.report_submitted': moderationReportSubmittedSchema,
  'moderation.report_resolved': moderationReportResolvedSchema,
  'moderation.punishment_expired': moderationPunishmentExpiredSchema,
  'moderation.report_action_requested': moderationReportActionRequestedSchema,
} as const;

export type ModerationEventType = keyof typeof MODERATION_EVENT_SCHEMAS;

export function moderationEvent<T extends ModerationEventType>(
  type: T,
  payload: z.input<(typeof MODERATION_EVENT_SCHEMAS)[T]>,
  options: EventOptions = {},
): ProtonEvent {
  return protonEvent(type, MODERATION_EVENT_SCHEMAS[type].parse(payload), options);
}

const INTERACTION_EVENT_TYPES: Partial<Record<number, EventType>> = {
  [InteractionType.ApplicationCommand]: 'interaction.command',
  [InteractionType.MessageComponent]: 'interaction.component',
  [InteractionType.ApplicationCommandAutocomplete]: 'interaction.autocomplete',
  [InteractionType.ModalSubmit]: 'interaction.modal',
};

const DISPATCH_EVENT_TYPES: Partial<Record<string, EventType>> = {
  GUILD_CREATE: 'guild.available',
  GUILD_MEMBER_ADD: 'member.joined',
  MESSAGE_CREATE: 'message.created',
  MESSAGE_DELETE: 'message.deleted',
  MESSAGE_REACTION_ADD: 'reaction.added',
  MESSAGE_REACTION_REMOVE: 'reaction.removed',
};

export function fixtureEvent(name: DispatchName, patch?: (d: RawObject) => void): ProtonEvent {
  const raw = dispatch(name);
  patch?.(raw.d);

  const type =
    raw.t === 'INTERACTION_CREATE'
      ? INTERACTION_EVENT_TYPES[Number(raw.d.type)]
      : DISPATCH_EVENT_TYPES[raw.t];
  if (!type) throw new Error(`the ${name} fixture (${raw.t}) has no event type in the harness`);

  const guildId =
    typeof raw.d.guild_id === 'string'
      ? raw.d.guild_id
      : type === 'guild.available'
        ? String(raw.d.id)
        : null;

  return {
    id: `${type}:${String(raw.d.id ?? raw.s)}`,
    type,
    guildId,
    occurredAt: Date.now(),
    payload: raw.d,
  };
}
