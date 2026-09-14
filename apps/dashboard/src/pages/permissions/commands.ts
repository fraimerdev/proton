import type { ModuleSummary } from '@proton/core';
import { RETIRED_COMMAND_ALIASES } from '@proton/module-permissions/config';
import { MODULE_BY_ID, MODULES, NAV_GROUPS } from '../../lib/modules/catalogue.ts';

export const ORPHAN_GROUP = 'Commands with no module';

export const MAX_LISTED_ROLES = 5;

export type Overrides = Record<string, string[]>;

export interface CommandRow {
  name: string;
  moduleId: string;
  moduleName: string;
  roles: readonly string[];
  inheritedFrom: string | undefined;
  orphan: boolean;
}

export interface CommandGroup {
  id: string;
  label: string;
  rows: readonly CommandRow[];
  gated: number;
}

export interface Folded {
  overrides: Overrides;
  inherited: ReadonlyMap<string, string>;
}

export function foldRetired(stored: Readonly<Record<string, readonly string[]>>): Folded {
  const overrides: Overrides = {};
  for (const [name, roles] of Object.entries(stored)) overrides[name] = [...roles];

  const inherited = new Map<string, string>();

  for (const [retired, survivor] of Object.entries(RETIRED_COMMAND_ALIASES)) {
    const list = overrides[retired];
    if (list === undefined) continue;

    delete overrides[retired];

    const own = overrides[survivor];
    if (own === undefined || own.length === 0) {
      overrides[survivor] = list;
      inherited.set(survivor, retired);
    }
  }

  return { overrides, inherited };
}

function makeRow(
  name: string,
  moduleId: string,
  moduleName: string,
  folded: Folded,
  orphan: boolean,
): CommandRow {
  return {
    name,
    moduleId,
    moduleName,
    roles: folded.overrides[name] ?? [],
    inheritedFrom: folded.inherited.get(name),
    orphan,
  };
}

function gatedCount(rows: readonly CommandRow[]): number {
  return rows.filter((row) => row.roles.length > 0).length;
}

const GROUP_RANK = new Map(NAV_GROUPS.map((group, at) => [group.id, at]));
const MODULE_RANK = new Map(MODULES.map((module, at) => [module.id, at]));

function compareModules(a: ModuleSummary, b: ModuleSummary): number {
  const metaA = MODULE_BY_ID.get(a.id);
  const metaB = MODULE_BY_ID.get(b.id);

  if (metaA !== undefined && metaB !== undefined) {
    return (
      (GROUP_RANK.get(metaA.group) ?? 0) - (GROUP_RANK.get(metaB.group) ?? 0) ||
      (MODULE_RANK.get(a.id) ?? 0) - (MODULE_RANK.get(b.id) ?? 0)
    );
  }
  if (metaA !== undefined) return -1;
  if (metaB !== undefined) return 1;

  return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
}

export function buildGroups(
  modules: readonly ModuleSummary[],
  folded: Folded,
): readonly CommandGroup[] {
  const owning = [...modules].filter((module) => module.commands.length > 0).sort(compareModules);

  const owned = new Set(owning.flatMap((module) => module.commands));

  const groups: CommandGroup[] = owning.map((module) => {
    const label = MODULE_BY_ID.get(module.id)?.label ?? module.name;
    const rows = [...new Set(module.commands)]
      .sort()
      .map((name) => makeRow(name, module.id, label, folded, false));

    return { id: module.id, label, rows, gated: gatedCount(rows) };
  });

  const orphans = Object.keys(folded.overrides)
    .filter((name) => !owned.has(name))
    .sort()
    .map((name) => makeRow(name, '', ORPHAN_GROUP, folded, true));

  if (orphans.length > 0) {
    groups.push({ id: '', label: ORPHAN_GROUP, rows: orphans, gated: gatedCount(orphans) });
  }

  return groups;
}

export type ShowFilter = 'all' | 'gated' | 'open';

export function isShowFilter(value: string | undefined): value is ShowFilter {
  return value === 'all' || value === 'gated' || value === 'open';
}

export function filterGroups(
  groups: readonly CommandGroup[],
  { term, show, moduleId }: { term: string; show: ShowFilter; moduleId: string | undefined },
): readonly CommandGroup[] {
  const needle = term.trim().toLowerCase();

  return groups
    .filter((group) => moduleId === undefined || group.id === moduleId)
    .map((group) => {
      const rows = group.rows.filter((row) => {
        if (show === 'gated' && row.roles.length === 0) return false;
        if (show === 'open' && row.roles.length > 0) return false;
        if (needle === '') return true;
        return (
          row.name.toLowerCase().includes(needle) || group.label.toLowerCase().includes(needle)
        );
      });

      return { ...group, rows };
    })
    .filter((group) => group.rows.length > 0);
}

export function refusalSentence(
  commandName: string,
  required: readonly string[],
  roleName: (roleId: string) => string,
): string {
  const listed = required.slice(0, MAX_LISTED_ROLES);
  const overflow = required.length - listed.length;
  const mentions = listed.map((id) => `@${roleName(id)}`).join(', ');
  const more = overflow > 0 ? `, or ${overflow} other role${overflow === 1 ? '' : 's'}` : '';

  const roles =
    required.length === 1 ? `the ${mentions} role` : `one of these roles: ${mentions}${more}`;

  return (
    `You need ${roles} to use /${commandName} in this server. ` +
    'This is a Proton command override, not a Discord permission — a server admin can change it ' +
    `in the dashboard under Permissions → /${commandName}.`
  );
}
