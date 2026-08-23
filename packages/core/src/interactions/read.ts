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
}

export interface ModalInteraction extends InteractionBase {
  customId: string;

  fields: Record<string, string>;
  values: Record<string, string[]>;
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

export function readComponentInteraction(event: ProtonEvent): ComponentInteraction | null {
  const read = readBase(event, InteractionType.MessageComponent);
  if (!read) return null;

  const customId = str(read.data?.custom_id);
  if (!customId) return null;

  return {
    ...read.base,
    customId,
    componentType: typeof read.data?.component_type === 'number' ? read.data.component_type : 0,
    values: strings(read.data?.values),
    messageId: str(record(read.d.message)?.id),
  };
}

function collectModalFields(
  nodes: unknown,
  fields: Record<string, string>,
  values: Record<string, string[]>,
): void {
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    const item = record(node);
    if (!item) continue;

    if (Array.isArray(item.components)) {
      collectModalFields(item.components, fields, values);
      continue;
    }

    const wrapped = record(item.component);
    if (wrapped) {
      collectModalFields([wrapped], fields, values);
      continue;
    }

    const customId = str(item.custom_id);
    if (!customId) continue;

    const value = str(item.value);
    if (value !== null) fields[customId] = value;
    if (Array.isArray(item.values)) values[customId] = strings(item.values);
  }
}

export function readModalInteraction(event: ProtonEvent): ModalInteraction | null {
  const read = readBase(event, InteractionType.ModalSubmit);
  if (!read) return null;

  const customId = str(read.data?.custom_id);
  if (!customId) return null;

  const fields: Record<string, string> = {};
  const values: Record<string, string[]> = {};
  collectModalFields(read.data?.components, fields, values);

  return { ...read.base, customId, fields, values };
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
