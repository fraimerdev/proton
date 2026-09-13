import type { ModuleSummary } from '@proton/core';
import type { PermissionsConfig } from '@proton/module-permissions/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import {
  Button,
  Checkbox,
  IconButton,
  SearchField,
  Select,
  type SelectOption,
} from '../../components/ui/controls.tsx';
import { EmptyState, Spinner } from '../../components/ui/feedback.tsx';
import { Section } from '../../components/ui/layout.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { rolesQuery } from '../../lib/queries.ts';
import {
  buildGroups,
  type CommandGroup,
  type CommandRow,
  filterGroups,
  foldRetired,
  isShowFilter,
  type Overrides,
  refusalSentence,
  type ShowFilter,
} from './commands.ts';

const SHOW_TABS: readonly { id: ShowFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'gated', label: 'Restricted' },
  { id: 'open', label: 'Unrestricted' },
];

const OPEN_NOTE =
  'Unrestricted commands have no Proton override. Discord’s own command permissions still apply, ' +
  'and the dashboard cannot read them, so unrestricted does not mean anyone can use a command.';

const OFF_NOTE =
  'Permissions is switched off. Settings are saved, but nothing runs until you switch it on. ' +
  'Discord’s own command permissions apply instead.';

export function CommandMatrix({
  guildId,
  moduleId,
  form,
  modules,
  gating,
}: {
  guildId: string;
  moduleId: string;
  form: ModuleForm<PermissionsConfig>;
  modules: readonly ModuleSummary[];
  gating: boolean;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);

  const term = search.q ?? '';
  const [draft, setDraft] = useState(term);
  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? undefined : trimmed;
    if ((next ?? '') === term) return;

    const timer = window.setTimeout(() => go({ q: next }), 220);
    return () => window.clearTimeout(timer);
  }, [draft, term, go]);

  const show: ShowFilter = isShowFilter(search.status) ? search.status : 'all';

  const { setValue } = form;
  const folded = useMemo(() => foldRetired(form.value.overrides), [form.value.overrides]);
  const groups = useMemo(() => buildGroups(modules, folded), [modules, folded]);

  const moduleFilter = groups.some((group) => group.id === search.id && group.id !== '')
    ? search.id
    : undefined;

  const visible = useMemo(
    () => filterGroups(groups, { term: draft, show, moduleId: moduleFilter }),
    [groups, draft, show, moduleFilter],
  );

  const total = groups.reduce((count, group) => count + group.rows.length, 0);
  const gated = groups.reduce((count, group) => count + group.gated, 0);

  const { data: roles, isPending: rolesPending } = useQuery(rolesQuery(guildId));
  const roleName = useCallback(
    (roleId: string) => roles?.find((role) => role.id === roleId)?.name ?? roleId,
    [roles],
  );

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkRoles, setBulkRoles] = useState<string[]>([]);

  const edit = useCallback(
    (change: (overrides: Overrides) => void) => {
      setValue((current) => {
        const next = foldRetired(current.overrides).overrides;
        change(next);
        return { ...current, overrides: next };
      });
    },
    [setValue],
  );

  // An empty list and an absent key mean the same thing to the gate, so the key goes rather than
  // leaving a trail of `[]` behind every command somebody opened and closed.
  const setRoles = useCallback(
    (name: string, next: readonly string[]) =>
      edit((overrides) => {
        if (next.length === 0) delete overrides[name];
        else overrides[name] = [...next];
      }),
    [edit],
  );

  const toggleRow = (name: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const toggleGroup = (group: CommandGroup, on: boolean): void =>
    setSelected((current) => {
      const next = new Set(current);
      for (const row of group.rows) {
        if (on) next.add(row.name);
        else next.delete(row.name);
      }
      return next;
    });

  const applyBulk = (mode: 'replace' | 'add'): void => {
    edit((overrides) => {
      for (const name of selected) {
        const merged =
          mode === 'replace'
            ? [...bulkRoles]
            : [...new Set([...(overrides[name] ?? []), ...bulkRoles])];

        if (merged.length === 0) delete overrides[name];
        else overrides[name] = merged;
      }
    });

    setBulkRoles([]);
    setSelected(new Set());
  };

  const clearSelected = (): void => {
    edit((overrides) => {
      for (const name of selected) delete overrides[name];
    });
    setSelected(new Set());
  };

  const endSelection = (): void => {
    setBulkRoles([]);
    setSelected(new Set());
  };

  const moduleOptions: readonly SelectOption[] = [
    { value: 'all', label: 'All modules' },
    ...groups
      .filter((group) => group.id !== '')
      .map((group) => ({ value: group.id, label: group.label })),
  ];

  const overridesError = form.errorAt('overrides');

  const clearFilters = (): void => {
    setDraft('');
    go({ q: undefined, status: undefined, id: undefined });
  };

  return (
    <Section
      label="Command overrides"
      note={
        gating
          ? `${gated} of ${total} commands restricted`
          : `${gated} of ${total} commands have overrides`
      }
    >
      {!gating ? <p className="permissions-note">{OFF_NOTE}</p> : null}

      <div className="matrix-toolbar permissions-toolbar">
        <SearchField
          value={draft}
          onChange={setDraft}
          label="Search commands"
          placeholder="Search commands or modules…"
        />
        <SegmentedTabs
          items={SHOW_TABS}
          value={show}
          label="Command filter"
          onChange={(next) => go({ status: next === 'all' ? undefined : next })}
        />
        <Select
          aria-label="Module"
          width="md"
          options={moduleOptions}
          value={moduleFilter ?? 'all'}
          onChange={(value) => go({ id: value === 'all' ? undefined : value })}
        />
      </div>

      {show === 'open' ? <p className="permissions-note">{OPEN_NOTE}</p> : null}

      {selected.size > 0 ? (
        <div className="permissions-bulk">
          <div className="permissions-bulk-line">
            <span className="permissions-bulk-count">
              {selected.size} command{selected.size === 1 ? '' : 's'} selected
            </span>
            <Button size="sm" tone="danger-quiet" onClick={clearSelected}>
              Clear overrides
            </Button>
            <Button size="sm" tone="ghost" className="push-right" onClick={endSelection}>
              Cancel
            </Button>
          </div>

          <div className="permissions-bulk-line">
            <RoleMultiPicker
              guildId={guildId}
              value={bulkRoles}
              label="Roles for the selected commands"
              onChange={setBulkRoles}
            />
            <Button size="sm" disabled={bulkRoles.length === 0} onClick={() => applyBulk('add')}>
              Add roles
            </Button>
            <Button
              size="sm"
              tone="primary"
              disabled={bulkRoles.length === 0}
              onClick={() => applyBulk('replace')}
            >
              Replace
            </Button>
          </div>
        </div>
      ) : null}

      {overridesError !== undefined ? (
        <p className="field-error permissions-note" role="alert">
          {overridesError}
        </p>
      ) : null}

      {total === 0 ? (
        <EmptyState icon="lock" title="No commands" inset>
          No module in this server has slash commands.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState
          icon="magnifying-glass"
          title="No commands match these filters"
          inset
          actions={
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className={gating ? 'matrix permissions-matrix' : 'matrix permissions-matrix off'}>
          {visible.map((group) => (
            <MatrixGroup
              key={group.id === '' ? 'orphans' : group.id}
              guildId={guildId}
              group={group}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleGroup={toggleGroup}
              onSetRoles={setRoles}
              roleName={roleName}
              rolesPending={rolesPending}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function MatrixGroup({
  guildId,
  group,
  selected,
  onToggleRow,
  onToggleGroup,
  onSetRoles,
  roleName,
  rolesPending,
}: {
  guildId: string;
  group: CommandGroup;
  selected: ReadonlySet<string>;
  onToggleRow: (name: string) => void;
  onToggleGroup: (group: CommandGroup, on: boolean) => void;
  onSetRoles: (name: string, roles: readonly string[]) => void;
  roleName: (roleId: string) => string;
  rolesPending: boolean;
}): ReactElement {
  const picked = group.rows.filter((row) => selected.has(row.name)).length;
  const state = picked === 0 ? false : picked === group.rows.length ? true : 'mixed';

  return (
    <div className="matrix-group">
      <div className="matrix-group-head">
        <Checkbox
          checked={state}
          label={`Select all commands in ${group.label}`}
          onChange={(on) => onToggleGroup(group, on)}
        />
        {group.label}
        <span className="matrix-group-count">
          {group.gated} of {group.rows.length} restricted
        </span>
      </div>

      {group.rows.map((row) => (
        <MatrixRow
          key={row.name}
          guildId={guildId}
          row={row}
          selected={selected.has(row.name)}
          onToggle={onToggleRow}
          onSetRoles={onSetRoles}
          roleName={roleName}
          rolesPending={rolesPending}
        />
      ))}
    </div>
  );
}

function rowHint(row: CommandRow): string | null {
  if (row.inheritedFrom !== undefined) {
    return `/${row.inheritedFrom} is now part of /${row.name}, and its roles moved here.`;
  }
  if (row.orphan) {
    return `No module in this server has /${row.name}, so this override does nothing.`;
  }
  if (row.roles.length === 0) return 'No override. Discord’s own command permissions apply.';
  return null;
}

function MatrixRow({
  guildId,
  row,
  selected,
  onToggle,
  onSetRoles,
  roleName,
  rolesPending,
}: {
  guildId: string;
  row: CommandRow;
  selected: boolean;
  onToggle: (name: string) => void;
  onSetRoles: (name: string, roles: readonly string[]) => void;
  roleName: (roleId: string) => string;
  rolesPending: boolean;
}): ReactElement {
  const hint = rowHint(row);

  return (
    <div className="matrix-row permissions-row">
      <Checkbox
        checked={selected}
        label={`Select /${row.name}`}
        onChange={() => onToggle(row.name)}
      />

      <div className="permissions-row-main">
        <div className="permissions-row-head">
          <span className="matrix-row-name mono">/{row.name}</span>
          {hint !== null ? <span className="matrix-row-hint">{hint}</span> : null}
        </div>

        {row.roles.length > 0 ? (
          <p className="permissions-refusal">
            {rolesPending ? (
              <Spinner label="Loading roles" />
            ) : (
              refusalSentence(row.name, row.roles, roleName)
            )}
          </p>
        ) : null}
      </div>

      <div className="matrix-row-control permissions-row-control">
        <RoleMultiPicker
          guildId={guildId}
          value={row.roles}
          label={`Roles that can use /${row.name}`}
          onChange={(next) => onSetRoles(row.name, next)}
        />
      </div>

      <span className="permissions-row-trailing">
        {row.roles.length > 0 || row.orphan ? (
          <IconButton
            icon="x"
            tone="ghost"
            size="sm"
            label={row.orphan ? `Remove override on /${row.name}` : `Clear roles on /${row.name}`}
            onClick={() => onSetRoles(row.name, [])}
          />
        ) : null}
      </span>
    </div>
  );
}
