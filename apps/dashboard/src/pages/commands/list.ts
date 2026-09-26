import type { CommandView } from '@proton/core';
import { MODULE_BY_ID, MODULES, NAV_GROUPS } from '../../lib/modules/catalogue.ts';

export interface CommandGroup {
  id: string;
  label: string;
  commands: readonly CommandView[];
}

export function moduleLabel(command: Pick<CommandView, 'moduleId' | 'moduleName'>): string {
  return MODULE_BY_ID.get(command.moduleId)?.label ?? command.moduleName;
}

export function commandLabel(command: Pick<CommandView, 'kind' | 'effectiveName'>): string {
  return command.kind === 'chat' ? `/${command.effectiveName}` : command.effectiveName;
}

export function isRenamed(command: CommandView): boolean {
  return command.kind === 'chat' && command.effectiveName !== command.name;
}

export function commandHints(command: CommandView): string[] {
  const label = commandLabel(command);
  const module = moduleLabel(command);
  const hints: string[] = [];

  if (command.ignored !== null) hints.push(command.ignored);
  if (isRenamed(command)) hints.push(`Renamed from /${command.name}`);

  if (!command.moduleOn && command.alwaysRegistered) {
    if (command.settings.enabled) {
      hints.push(
        `${label} stays available while ${module} is off, so there’s always a way to find the dashboard.`,
      );
    }
  } else if (!command.moduleOn) {
    hints.push(`${module} is off, so members can’t see ${label}.`);
  }

  return hints;
}

export function replyOverrides(commands: readonly CommandView[], moduleId: string): string[] {
  return commands
    .filter(
      (command) =>
        command.moduleId === moduleId &&
        command.kind === 'chat' &&
        command.reply?.supported === true &&
        command.settings.privateReply !== null,
    )
    .sort(compareCommands)
    .map(
      (command) =>
        `${commandLabel(command)} replies ${command.settings.privateReply ? 'privately' : 'publicly'}`,
    );
}

export function noModulesOn(commands: readonly CommandView[]): boolean {
  return commands.length > 0 && commands.every((command) => !command.moduleOn);
}

const GROUP_RANK = new Map(NAV_GROUPS.map((group, at) => [group.id, at]));
const MODULE_RANK = new Map(MODULES.map((module, at) => [module.id, at]));

function moduleOrder(moduleId: string): [number, number] {
  const meta = MODULE_BY_ID.get(moduleId);
  if (meta === undefined) return [NAV_GROUPS.length, MODULES.length];
  return [GROUP_RANK.get(meta.group) ?? NAV_GROUPS.length, MODULE_RANK.get(moduleId) ?? 0];
}

const KIND_RANK = { chat: 0, user: 1, message: 2 } as const;

function compareCommands(a: CommandView, b: CommandView): number {
  return (
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    a.effectiveName.localeCompare(b.effectiveName) ||
    a.key.localeCompare(b.key)
  );
}

export function groupCommands(commands: readonly CommandView[]): CommandGroup[] {
  const byModule = new Map<string, CommandView[]>();

  for (const command of commands) {
    byModule.set(command.moduleId, [...(byModule.get(command.moduleId) ?? []), command]);
  }

  return [...byModule.entries()]
    .map(([id, members]) => ({
      id,
      label: moduleLabel(members[0] ?? { moduleId: id, moduleName: id }),
      commands: [...members].sort(compareCommands),
    }))
    .sort((a, b) => {
      const [groupA, moduleA] = moduleOrder(a.id);
      const [groupB, moduleB] = moduleOrder(b.id);
      return groupA - groupB || moduleA - moduleB || a.label.localeCompare(b.label);
    });
}

function matches(command: CommandView, group: CommandGroup, needle: string): boolean {
  return [command.effectiveName, command.name, group.label].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

export function filterGroups(
  groups: readonly CommandGroup[],
  { term, moduleId }: { term: string; moduleId: string | undefined },
): CommandGroup[] {
  const needle = term.trim().replace(/^\//, '').toLowerCase();

  return groups
    .filter((group) => moduleId === undefined || group.id === moduleId)
    .map((group) => ({
      ...group,
      commands:
        needle === ''
          ? group.commands
          : group.commands.filter((command) => matches(command, group, needle)),
    }))
    .filter((group) => group.commands.length > 0);
}
