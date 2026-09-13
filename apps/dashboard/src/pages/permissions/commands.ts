import type { ModuleSummary } from '@proton/core';
import { RETIRED_COMMAND_ALIASES } from '@proton/module-permissions/config';

export const ORPHAN_GROUP = 'Commands with no module';

export const MAX_LISTED_ROLES = 5;

export type Overrides = Record<string, string[]>;

export interface CommandRow {
  name: string;
  moduleId: string;
  moduleName: string;
  roles: readonly string[];
  /** The retired command name whose role list this row is standing in for. */
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

/**
 * The same fold `liftStoredConfig` and `requiredRolesFor` do: a retired name never gets a row of
 * its own, and its list moves to the command that replaced it only where that one is empty.
 */
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

/**
 * Rows are the real command set — every name the module index reports — plus any override key left
 * behind by a module that is not running here. Never a hardcoded list: commands arrive by phase.
 */
export function buildGroups(
  modules: readonly ModuleSummary[],
  folded: Folded,
): readonly CommandGroup[] {
  const owning = [...modules]
    .filter((module) => module.commands.length > 0)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const owned = new Set(owning.flatMap((module) => module.commands));

  const groups: CommandGroup[] = owning.map((module) => {
    const rows = [...new Set(module.commands)]
      .sort()
      .map((name) => makeRow(name, module.id, module.name, folded, false));

    return { id: module.id, label: module.name, rows, gated: gatedCount(rows) };
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

// Copied from describeRefusal in permissions/src/gate.ts, which the package does not export on a
// browser-safe subpath. It is security copy a member actually reads, so it must not be reworded.
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
