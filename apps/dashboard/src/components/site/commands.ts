import type { Category } from '../shell/module-meta.ts';
import { CATALOGUE, type CatalogueEntry } from './catalogue.ts';
import { COMMAND_SET, type CommandEntry } from './command-set.gen.ts';

export { COMMAND_SET, type CommandArg, type CommandEntry } from './command-set.gen.ts';

export function moduleOf(id: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === id);
}

export function usageLine(command: CommandEntry): string {
  const args = command.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`));

  return [command.usage, ...args].join(' ');
}

export interface CommandGroup {
  module: CatalogueEntry;
  commands: readonly CommandEntry[];
}

// Lower-cased once per command rather than once per keystroke: the whole set is filtered on every
// character typed, and every command carries a usage line, a description and a module name.
const HAYSTACK = new Map(
  COMMAND_SET.map((command) => [
    command,
    `${usageLine(command)} ${command.description} ${moduleOf(command.module)?.name ?? ''}`.toLowerCase(),
  ]),
);

export function matches(command: CommandEntry, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^\//, '');
  if (!needle) return true;

  return (HAYSTACK.get(command) ?? '').includes(needle);
}

export function groupCommands(query: string, category: Category | 'all'): CommandGroup[] {
  const groups: CommandGroup[] = [];

  for (const module of CATALOGUE) {
    if (category !== 'all' && module.category !== category) continue;

    const commands = COMMAND_SET.filter(
      (command) => command.module === module.id && matches(command, query),
    );

    if (commands.length > 0) groups.push({ module, commands });
  }

  return groups;
}
