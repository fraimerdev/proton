import type { ModuleSummary } from '@proton/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactElement, useId, useMemo, useState } from 'react';
import type { DiscordRole } from '../../../components/form/picker.tsx';
import { roleStyle } from '../../../components/form/picker.tsx';
import { SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import { Icon } from '../../../components/shell/icon.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';
import { useToggleModule } from '../../../components/shell/module-toggle.tsx';
import { modulesQuery } from '../../../lib/queries.ts';

// An override the reader emptied is dropped, not stored as an empty list: the config would
// otherwise grow a key for every command anybody ever opened, all of them meaning "no override".
function pruneOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const overrides = config.overrides;
  if (typeof overrides !== 'object' || overrides === null) return config;

  return {
    ...config,
    overrides: Object.fromEntries(
      Object.entries(overrides as Record<string, unknown>).filter(
        ([, roles]) => !Array.isArray(roles) || roles.length > 0,
      ),
    ),
  };
}

export const Route = createFileRoute('/dashboard/$guildId/permissions')({
  ...moduleRoute('permissions'),
  component: PermissionsPage,
});

interface CommandGroup {
  id: string;
  name: string;
  commands: readonly string[];
}

// Every installed module's commands, not this module's: an override names a command Proton gates,
// and Permissions itself registers none. A command two modules both list is filed under the first
// to claim it, because a row in two groups is a row whose two checkboxes write the same key.
function commandGroups(modules: readonly ModuleSummary[]): CommandGroup[] {
  const claimed = new Set<string>();

  return [...modules]
    .sort((first, second) => first.name.localeCompare(second.name))
    .map((module) => {
      const commands = [...new Set(module.commands)].sort().filter((name) => !claimed.has(name));
      for (const name of commands) claimed.add(name);

      return { id: module.id, name: module.name, commands };
    })
    .filter((group) => group.commands.length > 0);
}

function PermissionsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'permissions', false, pruneOverrides);

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;
  const groups = useMemo(() => commandGroups(modules), [modules]);

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <OffBand summary={form.summary} />

        <SettingsGrid>
          <SectionCard
            id="permissions:overrides"
            title="Command overrides"
            span="full"
            hint="A command left empty falls back to Discord’s own command permissions."
          >
            <CommandMatrix form={form} groups={groups} />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}

function OffBand({ summary }: { summary: ModuleSummary }): ReactElement | null {
  const toggle = useToggleModule();
  if (moduleState(summary) !== 'off') return null;

  return (
    <div className="module-off">
      <Icon name="lightning-slash" />
      <p className="module-off-text">
        {summary.name} is switched off. These settings are saved, and nothing runs in this server
        until you switch it on.
      </p>
      <button type="button" className="button button-quiet" onClick={() => toggle(summary, true)}>
        Switch {summary.name} on
      </button>
    </div>
  );
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function CommandMatrix({
  form,
  groups,
}: {
  form: ModuleForm;
  groups: readonly CommandGroup[];
}): ReactElement {
  const searchId = useId();
  const roleFilterId = useId();

  const [query, setQuery] = useState('');
  const [only, setOnly] = useState('');
  const [overriddenOnly, setOverriddenOnly] = useState(false);

  const roles = useMemo(
    () => [...form.roles].sort((first, second) => second.position - first.position),
    [form.roles],
  );

  const columns = only === '' ? roles : roles.filter((role) => role.id === only);
  const known = useMemo(() => new Set(roles.map((role) => role.id)), [roles]);

  function held(name: string): readonly string[] {
    const value = form.value(`overrides.${name}`, []);
    return Array.isArray(value) ? (value as string[]) : [];
  }

  function write(name: string, next: readonly string[]): void {
    form.set(`overrides.${name}`, unique(next));
  }

  const needle = query.trim().toLowerCase().replace(/^\//, '');

  function rowsOf(group: CommandGroup): readonly string[] {
    return group.commands.filter(
      (name) =>
        (needle === '' || name.includes(needle)) && (!overriddenOnly || held(name).length > 0),
    );
  }

  const shown = groups.map((group) => ({ group, rows: rowsOf(group) }));
  const total = shown.reduce((count, entry) => count + entry.rows.length, 0);
  const commands = groups.reduce((count, group) => count + group.commands.length, 0);
  const overridden = groups.reduce(
    (count, group) => count + group.commands.filter((name) => held(name).length > 0).length,
    0,
  );

  return (
    <div className="matrix-area panel-wide" data-path="overrides">
      <p className="field-description">
        A command with nobody ticked is Discord’s to answer, through Server Settings → Integrations.
        Tick a role and Proton answers instead: only the roles ticked here can run it.
      </p>

      <div className="matrix-filters">
        <label className="matrix-filter" htmlFor={searchId}>
          <span>Find a command</span>
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="ban, ticket, tag…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="matrix-filter" htmlFor={roleFilterId}>
          <span>Show</span>
          <select id={roleFilterId} value={only} onChange={(event) => setOnly(event.target.value)}>
            <option value="">Every role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>

        <label className="matrix-toggle">
          <input
            type="checkbox"
            checked={overriddenOnly}
            onChange={(event) => setOverriddenOnly(event.target.checked)}
          />
          <span>Only overridden</span>
        </label>

        <span className="matrix-tally">
          {overridden === 0
            ? `Nothing overridden — all ${commands} commands follow Discord`
            : `${overridden} of ${commands} commands overridden`}
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="field-empty">
          No module in this server registers a command, so there is nothing to override.
        </p>
      ) : columns.length === 0 ? (
        <p className="field-empty">
          This server has no roles yet. An override names a role, so make one in Discord first.
        </p>
      ) : total === 0 ? (
        <p className="field-empty">
          No command matches{needle === '' ? '' : ` “${needle}”`}
          {overriddenOnly ? ' with an override on it' : ''}.
        </p>
      ) : (
        <div className="matrix-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th className="matrix-command" scope="col">
                  Command
                </th>
                {columns.map((role) => (
                  <th className="matrix-role" key={role.id} scope="col" title={role.name}>
                    <span className="matrix-role-name">
                      <span
                        aria-hidden="true"
                        className="matrix-role-dot"
                        style={roleStyle(role.color)}
                      />
                      {role.name}
                    </span>
                  </th>
                ))}
                <th className="matrix-state" scope="col">
                  Who can run it
                </th>
              </tr>
            </thead>

            {shown.map(({ group, rows }) =>
              rows.length === 0 ? null : (
                <tbody key={group.id}>
                  <tr className="matrix-group">
                    {/* The flex row is inside the cell, not the cell itself: a th given display:flex
                        leaves the table formatting context and stops spanning its columns. */}
                    <th colSpan={columns.length + 2} scope="rowgroup">
                      <span className="matrix-group-row">
                        <span className="matrix-group-name">{group.name}</span>
                        <span className="matrix-group-actions">
                          <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => {
                              for (const name of rows) {
                                write(name, [...held(name), ...columns.map((role) => role.id)]);
                              }
                            }}
                          >
                            {columns.length === 1
                              ? `Allow ${columns[0]?.name ?? 'this role'}`
                              : 'Allow every role shown'}
                          </button>
                          <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => {
                              for (const name of rows) write(name, []);
                            }}
                          >
                            Back to Discord’s default
                          </button>
                        </span>
                      </span>
                    </th>
                  </tr>

                  {rows.map((name) => (
                    <MatrixRow
                      columns={columns}
                      held={held(name)}
                      known={known}
                      key={name}
                      name={name}
                      onChange={(next) => write(name, next)}
                    />
                  ))}
                </tbody>
              ),
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function MatrixRow({
  name,
  columns,
  held,
  known,
  onChange,
}: {
  name: string;
  columns: readonly DiscordRole[];
  held: readonly string[];
  known: ReadonlySet<string>;
  onChange: (next: readonly string[]) => void;
}): ReactElement {
  const gone = held.filter((roleId) => !known.has(roleId));

  return (
    <tr data-path={`overrides.${name}`}>
      <th className="matrix-command" scope="row">
        <code>/{name}</code>
      </th>

      {columns.map((role) => (
        <td className="matrix-cell" key={role.id}>
          <input
            type="checkbox"
            aria-label={`${role.name} may run /${name}`}
            checked={held.includes(role.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...held, role.id]
                  : held.filter((roleId) => roleId !== role.id),
              )
            }
          />
        </td>
      ))}

      <td className="matrix-state">
        {held.length === 0 ? (
          <span className="matrix-default">Discord’s default</span>
        ) : (
          <span className="matrix-count">
            {held.length} role{held.length === 1 ? '' : 's'}
          </span>
        )}

        {/* A role that was ticked and has since been deleted in Discord. It still gates the
            command, and no column can show it, so the row has to say so or the count reads wrong. */}
        {gone.length === 0 ? null : (
          <button
            type="button"
            className="button button-ghost matrix-gone"
            onClick={() => onChange(held.filter((roleId) => known.has(roleId)))}
          >
            Drop {gone.length} deleted role{gone.length === 1 ? '' : 's'}
          </button>
        )}
      </td>
    </tr>
  );
}
