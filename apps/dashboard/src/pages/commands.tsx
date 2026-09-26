import type { CommandCatalogueView, CommandView } from '@proton/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { Workspace } from '../components/shell/app-shell.tsx';
import { Button, SearchField, Select, type SelectOption } from '../components/ui/controls.tsx';
import { EmptyState, LoadingArea, Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { HelpTip } from '../components/ui/overlay.tsx';
import { readFailure, saveFailure } from '../lib/errors.ts';
import { botInviteUrl } from '../lib/invite.ts';
import {
  ackLostCommandPermissionsMutation,
  guildCommandsQuery,
  sessionQuery,
  setGuildCommandEnabledMutation,
} from '../lib/queries.ts';
import { queryKeys } from '../lib/query-keys.ts';
import { EditCommandDialog } from './commands/dialog.tsx';
import { commandLabel, filterGroups, groupCommands } from './commands/list.ts';
import {
  CommandBanners,
  CommandGroupSection,
  CommandListRow,
  SWITCH_CAVEAT,
  SWITCH_HELP,
  syncNote,
} from './commands/rows.tsx';

export const commandsSearchSchema = z.object({
  q: z.string().optional(),
  id: z.string().optional(),
});

export type CommandsSearch = z.infer<typeof commandsSearchSchema>;

export const COMMANDS_SUBTITLE =
  'Rename Proton’s slash commands, edit their descriptions and choose which ones this server shows.';

function CommandsHeader(): ReactElement {
  return (
    <header className="page-head">
      <div className="page-head-main">
        <h1 className="page-title">
          <Icon name="terminal-window" size={28} className="page-title-icon" />
          Commands
        </h1>
        <p className="page-subtitle">{COMMANDS_SUBTITLE}</p>
      </div>
    </header>
  );
}

export function CommandsPending(): ReactElement {
  return (
    <Workspace>
      <CommandsHeader />
      <LoadingArea label="Loading commands" minHeight={280} size="lg" fill fallback />
    </Workspace>
  );
}

function flipped(
  view: CommandCatalogueView | undefined,
  key: string,
  enabled: boolean,
): CommandCatalogueView | undefined {
  return (
    view && {
      ...view,
      commands: view.commands.map((command) =>
        command.key === key ? { ...command, settings: { ...command.settings, enabled } } : command,
      ),
    }
  );
}

function CommandRowItem({
  guildId,
  command,
  onEdit,
}: {
  guildId: string;
  command: CommandView;
  onEdit: (key: string) => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const key = queryKeys.commands(guildId);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = useMutation({
    ...setGuildCommandEnabledMutation(queryClient, guildId),
    onMutate: async ({ enabled }) => {
      setFailure(null);
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<CommandCatalogueView>(key, (current) =>
        flipped(current, command.key, enabled),
      );
    },
    onError: (error: Error, { enabled }) => {
      queryClient.setQueryData<CommandCatalogueView>(key, (current) =>
        flipped(current, command.key, !enabled),
      );
      setFailure(
        saveFailure(error, `Couldn’t turn ${commandLabel(command)} ${enabled ? 'on' : 'off'}`),
      );
    },
  });

  return (
    <CommandListRow
      command={command}
      busy={toggle.isPending}
      failure={failure}
      onToggle={(enabled) => toggle.mutate({ key: command.key, enabled })}
      onEdit={() => onEdit(command.key)}
    />
  );
}

function useDebouncedTerm(
  term: string,
  onSearch: (patch: CommandsSearch) => void,
): [string, (value: string) => void] {
  const [draft, setDraft] = useState(term);
  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? undefined : trimmed;
    if ((next ?? '') === term) return;

    const timer = window.setTimeout(() => onSearch({ q: next }), 220);
    return () => window.clearTimeout(timer);
  }, [draft, term, onSearch]);

  return [draft, setDraft];
}

function CommandList({
  guildId,
  view,
  search,
  onSearch,
}: {
  guildId: string;
  view: CommandCatalogueView;
  search: CommandsSearch;
  onSearch: (patch: CommandsSearch) => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const invite = useQuery(sessionQuery()).data?.invite ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [term, setTerm] = useDebouncedTerm(search.q ?? '', onSearch);
  const [ackFailure, setAckFailure] = useState<string | null>(null);

  const acknowledge = useMutation({
    ...ackLostCommandPermissionsMutation(queryClient, guildId),
    onMutate: () => setAckFailure(null),
    onError: (error: Error) => setAckFailure(saveFailure(error, 'Couldn’t dismiss this notice')),
  });

  const groups = useMemo(() => groupCommands(view.commands), [view.commands]);
  const moduleFilter = groups.some((group) => group.id === search.id) ? search.id : undefined;
  const visible = useMemo(
    () => filterGroups(groups, { term, moduleId: moduleFilter }),
    [groups, term, moduleFilter],
  );

  const note = syncNote(view);

  const moduleOptions: readonly SelectOption[] = [
    { value: 'all', label: 'All modules' },
    ...groups.map((group) => ({ value: group.id, label: group.label })),
  ];

  const editingCommand =
    editing === null ? null : (view.commands.find((command) => command.key === editing) ?? null);

  return (
    <>
      <CommandBanners
        view={view}
        overview={
          <Link to="/dashboard/$guildId" params={{ guildId }}>
            Overview
          </Link>
        }
        inviteHref={invite !== null ? botInviteUrl(invite, guildId) : '/invite'}
        acknowledging={acknowledge.isPending}
        ackFailure={ackFailure}
        onAcknowledge={() => acknowledge.mutate()}
      />

      <section className="section" aria-label="Commands in this server">
        <p className="section-intro">
          {SWITCH_CAVEAT} <HelpTip label="Discord’s daily limit">{SWITCH_HELP}</HelpTip>
        </p>

        {note !== null ? (
          <p className="commands-sync-note" aria-live="polite">
            {view.sync.state === 'pending' ? (
              <Spinner size="sm" label="Sending to Discord" />
            ) : null}
            {note}
          </p>
        ) : null}

        <div className="matrix-toolbar">
          <SearchField
            value={term}
            onChange={setTerm}
            label="Search commands"
            placeholder="Search commands or modules…"
          />
          <Select
            aria-label="Module"
            width="md"
            options={moduleOptions}
            value={moduleFilter ?? 'all'}
            onChange={(value) => onSearch({ id: value === 'all' ? undefined : value })}
          />
        </div>

        {view.commands.length === 0 ? (
          <EmptyState icon="terminal-window" title="No commands to show" inset />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="magnifying-glass"
            title="No commands match these filters"
            inset
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setTerm('');
                  onSearch({ q: undefined, id: undefined });
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="commands-groups">
            {visible.map((group) => (
              <CommandGroupSection key={group.id} group={group}>
                {group.commands.map((command) => (
                  <CommandRowItem
                    key={command.key}
                    guildId={guildId}
                    command={command}
                    onEdit={setEditing}
                  />
                ))}
              </CommandGroupSection>
            ))}
          </div>
        )}
      </section>

      <EditCommandDialog
        guildId={guildId}
        command={editingCommand}
        catalogue={view.commands}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

export default function CommandsPage({
  guildId,
  search,
  onSearch,
}: {
  guildId: string;
  search: CommandsSearch;
  onSearch: (patch: CommandsSearch) => void;
}): ReactElement {
  const query = useQuery(guildCommandsQuery(guildId));

  return (
    <Workspace>
      <CommandsHeader />

      {query.data !== undefined ? (
        <CommandList guildId={guildId} view={query.data} search={search} onSearch={onSearch} />
      ) : query.isError ? (
        <StatusBanner
          tone="danger"
          live="polite"
          actions={
            <Button size="sm" busy={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          {readFailure(query.error, 'this server’s commands')}
        </StatusBanner>
      ) : (
        <LoadingArea label="Loading commands" minHeight={280} size="lg" fill />
      )}
    </Workspace>
  );
}
