import { InteractionType } from 'discord-api-types/v10';
import type { ProtonEvent } from '../events/types.ts';
import { OptionType, type RawOption } from '../modules/options.ts';

export interface InteractionBase {
  interactionId: string;
  token: string;
  type: number;
  applicationId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string;
  roleIds: string[] | null;
}

export interface ComponentInteraction extends InteractionBase {
  customId: string;
  componentType: number;
  values: string[];
  messageId: string | null;

  // An ephemeral message is reachable only through the interaction webhook, so editing one by its
  // channel and message id is a guaranteed 404.
  messageFlags: number | null;
}

export interface ModalInteraction extends InteractionBase {
  customId: string;

  fields: Record<string, string>;
  values: Record<string, string[]>;
  checks: Record<string, boolean>;
  attachments: Map<string, ResolvedAttachment>;
  messageId: string | null;
}

export interface ResolvedAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;
  proxyUrl: string | null;
  width: number | null;
  height: number | null;
  ephemeral: boolean;
  expiresAt: number | null;
}

export interface ResolvedUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  bot: boolean;
}

export interface ResolvedMember {
  roleIds: string[];
  nick: string | null;
  joinedAt: number | null;
  permissions: bigint | null;
  communicationDisabledUntil: number | null;
}

export interface ResolvedMessage {
  id: string;
  channelId: string;
  author: ResolvedUser | null;
  webhookId: string | null;
  content: string;
  createdAt: number | null;
  editedAt: number | null;
  type: number;
  flags: number;
  attachments: ResolvedAttachment[];
  embeds: Array<Record<string, unknown>>;
  stickerNames: string[];
  forwarded: boolean;
  snapshotContent: string | null;
}

export interface ResolvedData {
  users: Map<string, ResolvedUser>;
  members: Map<string, ResolvedMember>;
  messages: Map<string, ResolvedMessage>;
  attachments: Map<string, ResolvedAttachment>;
}

export interface FocusedOption {
  name: string;
  type: number;
  value: string;
}

export interface AutocompleteInteraction extends InteractionBase {
  commandName: string;
  subcommand: string | null;
  subcommandGroup: string | null;
  options: RawOption[];
  focused: FocusedOption | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

export function attachmentExpiry(url: string): number | null {
  let ex: string | null;
  try {
    ex = new URL(url).searchParams.get('ex');
  } catch {
    return null;
  }

  if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return null;
  return Number.parseInt(ex, 16) * 1000;
}

function toResolvedAttachment(raw: unknown): ResolvedAttachment | null {
  const item = record(raw);
  const id = str(item?.id);
  const filename = str(item?.filename);
  const url = str(item?.url);
  if (!item || !id || !filename || !url) return null;

  return {
    id,
    filename,
    contentType: str(item.content_type),
    size: num(item.size) ?? 0,
    url,
    proxyUrl: str(item.proxy_url),
    width: num(item.width),
    height: num(item.height),
    ephemeral: item.ephemeral === true,
    expiresAt: attachmentExpiry(url),
  };
}

function toResolvedUser(raw: unknown): ResolvedUser | null {
  const item = record(raw);
  const id = str(item?.id);
  const username = str(item?.username);
  if (!item || !id || !username) return null;

  return {
    id,
    username,
    globalName: str(item.global_name),
    avatar: str(item.avatar),
    bot: item.bot === true,
  };
}

function toResolvedMember(raw: unknown): ResolvedMember | null {
  const item = record(raw);
  if (!item) return null;

  let permissions: bigint | null = null;
  const bits = str(item.permissions);
  if (bits !== null) {
    try {
      permissions = BigInt(bits);
    } catch {
      permissions = null;
    }
  }

  return {
    roleIds: strings(item.roles),
    nick: str(item.nick),
    joinedAt: time(item.joined_at),
    permissions,
    communicationDisabledUntil: time(item.communication_disabled_until),
  };
}

export function toResolvedMessage(raw: unknown): ResolvedMessage | null {
  const item = record(raw);
  const id = str(item?.id);
  const channelId = str(item?.channel_id);
  if (!item || !id || !channelId) return null;

  const snapshots = records(item.message_snapshots);
  const stickers = Array.isArray(item.sticker_items) ? item.sticker_items : item.stickers;

  return {
    id,
    channelId,
    author: toResolvedUser(item.author),
    webhookId: str(item.webhook_id),
    content: str(item.content) ?? '',
    createdAt: time(item.timestamp),
    editedAt: time(item.edited_timestamp),
    type: num(item.type) ?? 0,
    flags: num(item.flags) ?? 0,
    attachments: records(item.attachments)
      .map(toResolvedAttachment)
      .filter((attachment): attachment is ResolvedAttachment => attachment !== null),
    embeds: records(item.embeds),
    stickerNames: records(stickers)
      .map((sticker) => str(sticker.name))
      .filter((name): name is string => name !== null),
    forwarded: snapshots.length > 0,
    snapshotContent: str(record(snapshots[0]?.message)?.content),
  };
}

function resolvedMap<T>(value: unknown, read: (raw: unknown) => T | null): Map<string, T> {
  const map = new Map<string, T>();
  for (const [key, raw] of Object.entries(record(value) ?? {})) {
    const item = read(raw);
    if (item !== null) map.set(key, item);
  }
  return map;
}

export function readResolved(payload: unknown): ResolvedData {
  const d = record(payload);
  const block = record(record(d?.data)?.resolved) ?? record(d?.resolved);

  return {
    users: resolvedMap(block?.users, toResolvedUser),
    members: resolvedMap(block?.members, toResolvedMember),
    messages: resolvedMap(block?.messages, toResolvedMessage),
    attachments: resolvedMap(block?.attachments, toResolvedAttachment),
  };
}

interface Interaction {
  d: Record<string, unknown>;
  data: Record<string, unknown> | null;
  base: InteractionBase;
}

function readBase(event: ProtonEvent, expected: InteractionType): Interaction | null {
  const d = record(event.payload);
  if (!d) return null;

  if (typeof d.type === 'number' && d.type !== expected) return null;

  const interactionId = str(d.id);
  const token = str(d.token);
  if (!interactionId || !token) return null;

  const member = record(d.member);
  const userId = str(record(member?.user)?.id) ?? str(record(d.user)?.id);
  if (!userId) return null;

  return {
    d,
    data: record(d.data),
    base: {
      interactionId,
      token,
      type: expected,
      applicationId: str(d.application_id),
      guildId: str(d.guild_id),
      channelId: str(d.channel_id) ?? str(record(d.channel)?.id),
      userId,
      roleIds: Array.isArray(member?.roles) ? strings(member.roles) : null,
    },
  };
}

// The invoking member's permissions, already resolved for this channel by Discord — not
// app_permissions, which is the bot's. Absent outside a guild, and 0n reads as "may do nothing",
// so a gate built on this fails closed.
export function readMemberPermissions(event: ProtonEvent): bigint {
  const raw = record(record(event.payload)?.member)?.permissions;
  if (typeof raw !== 'string') return 0n;

  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function readComponentInteraction(event: ProtonEvent): ComponentInteraction | null {
  const read = readBase(event, InteractionType.MessageComponent);
  if (!read) return null;

  const customId = str(read.data?.custom_id);
  if (!customId) return null;

  const flags = record(read.d.message)?.flags;

  return {
    ...read.base,
    customId,
    componentType: typeof read.data?.component_type === 'number' ? read.data.component_type : 0,
    values: strings(read.data?.values),
    messageId: str(record(read.d.message)?.id),
    messageFlags: typeof flags === 'number' ? flags : null,
  };
}

interface ModalAnswers {
  fields: Record<string, string>;
  values: Record<string, string[]>;
  checks: Record<string, boolean>;
}

function collectModalFields(nodes: unknown, answers: ModalAnswers): void {
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    const item = record(node);
    if (!item) continue;

    if (Array.isArray(item.components)) {
      collectModalFields(item.components, answers);
      continue;
    }

    const wrapped = record(item.component);
    if (wrapped) {
      collectModalFields([wrapped], answers);
      continue;
    }

    const customId = str(item.custom_id);
    if (!customId) continue;

    const value = str(item.value);
    if (value !== null) answers.fields[customId] = value;
    if (typeof item.value === 'boolean') answers.checks[customId] = item.value;
    if (Array.isArray(item.values)) answers.values[customId] = strings(item.values);
  }
}

export function readModalInteraction(event: ProtonEvent): ModalInteraction | null {
  const read = readBase(event, InteractionType.ModalSubmit);
  if (!read) return null;

  const customId = str(read.data?.custom_id);
  if (!customId) return null;

  const answers: ModalAnswers = { fields: {}, values: {}, checks: {} };
  collectModalFields(read.data?.components, answers);

  return {
    ...read.base,
    customId,
    ...answers,
    attachments: readResolved(read.d).attachments,
    messageId: str(record(read.d.message)?.id),
  };
}

function toRawOptions(value: unknown): RawOption[] {
  if (!Array.isArray(value)) return [];

  const options: RawOption[] = [];
  for (const item of value) {
    const option = record(item);
    const name = str(option?.name);
    if (!option || !name || typeof option.type !== 'number') continue;

    const scalar = option.value;
    options.push({
      name,
      type: option.type,
      ...(typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean'
        ? { value: scalar }
        : {}),
      ...(Array.isArray(option.options) ? { options: toRawOptions(option.options) } : {}),
    });
  }

  return options;
}

function findFocused(value: unknown): FocusedOption | null {
  if (!Array.isArray(value)) return null;

  for (const item of value) {
    const option = record(item);
    if (!option) continue;

    const name = str(option.name);
    if (option.focused === true && name) {
      return {
        name,
        type: typeof option.type === 'number' ? option.type : 0,
        value: option.value === undefined || option.value === null ? '' : String(option.value),
      };
    }

    const nested = findFocused(option.options);
    if (nested) return nested;
  }

  return null;
}

export function readAutocompleteInteraction(event: ProtonEvent): AutocompleteInteraction | null {
  const read = readBase(event, InteractionType.ApplicationCommandAutocomplete);
  if (!read) return null;

  const commandName = str(read.data?.name);
  if (!commandName) return null;

  const focused = findFocused(read.data?.options);

  let options = toRawOptions(read.data?.options);
  let subcommandGroup: string | null = null;
  let subcommand: string | null = null;

  if (options.length === 1 && options[0]?.type === OptionType.SubcommandGroup) {
    subcommandGroup = options[0].name;
    options = options[0].options ?? [];
  }

  if (options.length === 1 && options[0]?.type === OptionType.Subcommand) {
    subcommand = options[0].name;
    options = options[0].options ?? [];
  }

  return { ...read.base, commandName, subcommand, subcommandGroup, options, focused };
}
