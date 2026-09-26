import type {
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from 'discord-api-types/v10';
import { z } from 'zod';
import { OptionType } from '../modules/options.ts';

export type ChatCommandData = RESTPostAPIChatInputApplicationCommandsJSONBody;
export type ContextMenuData = RESTPostAPIContextMenuApplicationCommandsJSONBody;
export type CommandData = ChatCommandData | ContextMenuData;

export type Localizations = Partial<Record<string, string | null>> | null;

export interface CommandChoiceNode {
  name: string;
  name_localizations?: Localizations | undefined;
  value: string | number;
}

export interface CommandNode {
  name: string;
  name_localizations?: Localizations | undefined;
  description?: string | undefined;
  description_localizations?: Localizations | undefined;
  type?: number | undefined;
  required?: boolean | undefined;
  choices?: CommandChoiceNode[] | undefined;
  options?: CommandNode[] | undefined;
}

export function nodeOf(data: CommandData): CommandNode {
  return data as unknown as CommandNode;
}

export const COMMAND_FIELD_KINDS = ['group', 'subcommand', 'option'] as const;

export const COMMAND_OPTION_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'user',
  'channel',
  'role',
  'mentionable',
  'attachment',
] as const;

export type CommandOptionType = (typeof COMMAND_OPTION_TYPES)[number];

const OPTION_TYPE_NAMES: Readonly<Record<number, CommandOptionType>> = {
  [OptionType.String]: 'string',
  [OptionType.Integer]: 'integer',
  [OptionType.Number]: 'number',
  [OptionType.Boolean]: 'boolean',
  [OptionType.User]: 'user',
  [OptionType.Channel]: 'channel',
  [OptionType.Role]: 'role',
  [OptionType.Mentionable]: 'mentionable',
  [OptionType.Attachment]: 'attachment',
};

export const commandFieldSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(COMMAND_FIELD_KINDS),
  optionType: z.enum(COMMAND_OPTION_TYPES).optional(),
  required: z.boolean().optional(),
  description: z.string(),
  get children() {
    return z.array(commandFieldSchema);
  },
});

export type CommandField = z.infer<typeof commandFieldSchema>;

export function isBranch(node: CommandNode): boolean {
  return node.type === OptionType.Subcommand || node.type === OptionType.SubcommandGroup;
}

export function joinPath(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}.${name}`;
}

function fieldOf(node: CommandNode, prefix: string): CommandField {
  const path = joinPath(prefix, node.name);
  const description = node.description ?? '';

  if (node.type === OptionType.SubcommandGroup || node.type === OptionType.Subcommand) {
    return {
      path,
      name: node.name,
      kind: node.type === OptionType.SubcommandGroup ? 'group' : 'subcommand',
      description,
      children: (node.options ?? []).map((child) => fieldOf(child, path)),
    };
  }

  const optionType = node.type === undefined ? undefined : OPTION_TYPE_NAMES[node.type];

  return {
    path,
    name: node.name,
    kind: 'option',
    ...(optionType ? { optionType } : {}),
    required: node.required === true,
    description,
    children: [],
  };
}

export function commandFields(data: CommandData): CommandField[] {
  return (nodeOf(data).options ?? []).map((option) => fieldOf(option, ''));
}

export function fieldPaths(fields: readonly CommandField[]): Set<string> {
  const paths = new Set<string>();

  const visit = (list: readonly CommandField[]) => {
    for (const field of list) {
      paths.add(field.path);
      visit(field.children);
    }
  };
  visit(fields);

  return paths;
}

export function leafPaths(data: CommandData): string[] {
  const root = nodeOf(data).options ?? [];
  if (!root.some(isBranch)) return [''];

  const paths: string[] = [];
  for (const option of root) {
    if (option.type === OptionType.Subcommand) paths.push(option.name);
    if (option.type !== OptionType.SubcommandGroup) continue;

    for (const sub of option.options ?? []) {
      if (sub.type === OptionType.Subcommand) paths.push(joinPath(option.name, sub.name));
    }
  }

  return paths;
}
