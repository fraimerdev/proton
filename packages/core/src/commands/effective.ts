import { z } from 'zod';
import {
  type ChatCommandData,
  type CommandData,
  type CommandNode,
  commandFields,
  fieldPaths,
  isBranch,
  joinPath,
  type Localizations,
  nodeOf,
} from './fields.ts';
import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_NAME_MAX,
  COMMAND_NAME_PATTERN,
  COMMAND_SIZE_MAX,
  type CommandInput,
  type CommandSettings,
  codePointLength,
  filled,
  isCustomized,
} from './settings.ts';

export const commandIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type CommandIssue = z.infer<typeof commandIssueSchema>;

export type CommandCustomization = Pick<
  CommandSettings,
  'name' | 'description' | 'optionDescriptions'
>;

function ownValue(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function applyCommandSettings<D extends CommandData>(
  data: D,
  settings: CommandCustomization,
): D {
  const copy = structuredClone(data);
  const root = nodeOf(copy);

  if (filled(settings.name) && settings.name !== root.name) {
    root.name = settings.name;
    delete root.name_localizations;
  }

  if (filled(settings.description) && settings.description !== root.description) {
    root.description = settings.description;
    delete root.description_localizations;
  }

  const visit = (nodes: readonly CommandNode[], prefix: string) => {
    for (const node of nodes) {
      const path = joinPath(prefix, node.name);
      const override = ownValue(settings.optionDescriptions, path);

      if (filled(override) && override !== node.description) {
        node.description = override;
        delete node.description_localizations;
      }

      if (isBranch(node)) visit(node.options ?? [], path);
    }
  };
  visit(root.options ?? [], '');

  return copy;
}

function longest(text: string | undefined, localizations: Localizations | undefined): number {
  let size = codePointLength(text ?? '');

  for (const value of Object.values(localizations ?? {})) {
    if (typeof value === 'string') size = Math.max(size, codePointLength(value));
  }

  return size;
}

function sizeOf(node: CommandNode): number {
  let size =
    longest(node.name, node.name_localizations) +
    longest(node.description, node.description_localizations);

  for (const choice of node.choices ?? []) {
    size += longest(choice.name, choice.name_localizations) + codePointLength(String(choice.value));
  }

  for (const option of node.options ?? []) size += sizeOf(option);

  return size;
}

function fixedOf(node: CommandNode, root: boolean): number {
  let size = root ? 0 : longest(node.name, node.name_localizations);

  for (const choice of node.choices ?? []) {
    size += longest(choice.name, choice.name_localizations) + codePointLength(String(choice.value));
  }

  for (const option of node.options ?? []) size += fixedOf(option, false);

  return size;
}

export function commandSize(data: CommandData): number {
  return sizeOf(nodeOf(data));
}

export function fixedSize(data: CommandData): number {
  return fixedOf(nodeOf(data), true);
}

export function nameIssue(name: string): string | null {
  const length = codePointLength(name);

  if (length === 0) return 'Give the command a name.';
  if (length > COMMAND_NAME_MAX) {
    return `Command names can be at most ${COMMAND_NAME_MAX} characters (this one is ${length}).`;
  }
  if (name !== name.toLowerCase()) return 'Command names must be lowercase.';
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return 'Command names can only use letters, numbers, - and _, with no spaces.';
  }

  return null;
}

export function descriptionIssue(description: string | undefined): string | null {
  const text = description ?? '';
  const length = codePointLength(text);

  if (text.trim() === '') return 'Discord needs a description here.';
  if (length > COMMAND_DESCRIPTION_MAX) {
    return (
      `Descriptions can be at most ${COMMAND_DESCRIPTION_MAX} characters ` +
      `(this one is ${length}).`
    );
  }

  return null;
}

export function sizeIssue(size: number): string | null {
  if (size <= COMMAND_SIZE_MAX) return null;

  return (
    `Discord allows ${COMMAND_SIZE_MAX} characters per command across its name, descriptions, ` +
    `option names and choices, and this one has ${size}. Shorten some descriptions.`
  );
}

export function validateCommand(data: ChatCommandData): CommandIssue[] {
  const root = nodeOf(data);
  const issues: CommandIssue[] = [];

  const name = nameIssue(root.name);
  if (name) issues.push({ path: 'name', message: name });

  const description = descriptionIssue(root.description);
  if (description) issues.push({ path: 'description', message: description });

  const visit = (nodes: readonly CommandNode[], prefix: string) => {
    for (const node of nodes) {
      const path = joinPath(prefix, node.name);
      const message = descriptionIssue(node.description);
      if (message) issues.push({ path: `options.${path}`, message });

      if (isBranch(node)) visit(node.options ?? [], path);
    }
  };
  visit(root.options ?? [], '');

  const size = sizeIssue(commandSize(data));
  if (size) issues.push({ path: 'size', message: size });

  return issues;
}

function normalizedText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

export function normalizeCommandName(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  const bare = trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
  return bare === '' ? null : bare.toLowerCase();
}

export function normalizeCommandInput(
  data: ChatCommandData,
  stored: CommandSettings,
  input: CommandInput,
): CommandSettings {
  const name = normalizeCommandName(input.name);
  const description = normalizedText(input.description);

  const optionDescriptions: Record<string, string> = {};
  const fields = commandFields(data);
  const current = fieldPaths(fields);

  const visit = (list: typeof fields) => {
    for (const field of list) {
      const submitted = normalizedText(ownValue(input.optionDescriptions, field.path));
      if (submitted !== null && submitted !== field.description) {
        optionDescriptions[field.path] = submitted;
      }
      visit(field.children);
    }
  };
  visit(fields);

  const next: CommandSettings = {
    enabled: stored.enabled,
    name: name === data.name ? null : name,
    description: description === data.description ? null : description,
    optionDescriptions,
    privateReply: input.privateReply,
  };

  // An all-blank save is Reset to defaults, so it drops overrides of options the code removed too.
  if (!isCustomized(next)) return next;

  for (const [path, value] of Object.entries(stored.optionDescriptions)) {
    if (!current.has(path)) optionDescriptions[path] = value;
  }

  return next;
}
