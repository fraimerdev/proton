import { ACTION_KINDS, type ActionKind, type CaseRecord, caseIdSchema } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MemberCell, MemberProvider, useMember } from '../../components/discord/member.tsx';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import {
  Badge,
  Button,
  Field,
  SearchField,
  Select,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { Pair, Pairs } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import { readFailure } from '../../lib/errors.ts';
import { MEMBER_LOOKUP_MAX, membersQuery } from '../../lib/queries.ts';
import { caseLinkFilter, casesQuery, DEFAULT_PAGE_SIZE, PAGE_SIZES } from './queries.ts';

const SNOWFLAKE = /^\d{17,20}$/;

// snowflakeSchema's own message, so the dashboard and the api refuse a bad id in the same words.
const NOT_A_SNOWFLAKE = 'must be a Discord snowflake';

// caseQuerySchema's refine, which reports against `from`.
const RANGE_BACKWARDS = 'the start of the date range must not be after its end';

const KIND_LABELS: Record<ActionKind, string> = {
  send: 'Message sent',
  edit_message: 'Message edited',
  delete_message: 'Message deleted',
  add_reaction: 'Reaction added',
  interaction_reply: 'Command reply',
  interaction_followup: 'Command follow-up',
  warn: 'Warn',
  unwarn: 'Warning removed',
  ban: 'Ban',
  unban: 'Unban',
  kick: 'Kick',
  timeout: 'Timeout',
  untimeout: 'Timeout removed',
  add_role: 'Role added',
  remove_role: 'Role removed',
  purge: 'Messages purged',
  slowmode: 'Slowmode',
  lockdown: 'Lockdown',
  unlock: 'Unlock',
  create_channel: 'Channel created',
  create_role: 'Role created',
  delete_role: 'Role deleted',
  delete_channel: 'Channel deleted',
  edit_channel: 'Channel edited',
  set_channel_overwrite: 'Channel permission set',
  delete_channel_overwrite: 'Channel permission removed',
  create_thread: 'Thread created',
  move_member: 'Member moved',
  set_member_nickname: 'Nickname changed',
  end_poll: 'Poll ended',
  pin_message: 'Message pinned',
  automod_rule_create: 'AutoMod rule created',
  automod_rule_update: 'AutoMod rule updated',
  automod_rule_delete: 'AutoMod rule deleted',
  giveaway_draw: 'Giveaway drawn',
  create_dm: 'Direct message opened',
  set_bot_nickname: 'Proton nickname changed',
  set_bot_profile: 'Proton profile changed',
  set_bot_name_style: 'Proton name style changed',
};

const MODERATION_KINDS: readonly ActionKind[] = [
  'warn',
  'unwarn',
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
];

const CHANNEL_KINDS: readonly ActionKind[] = [
  'slowmode',
  'lockdown',
  'unlock',
  'purge',
  'create_channel',
  'edit_channel',
  'delete_channel',
  'set_channel_overwrite',
  'delete_channel_overwrite',
  'create_thread',
];

const ROLE_KINDS: readonly ActionKind[] = ['add_role', 'remove_role', 'create_role', 'delete_role'];

const MESSAGE_KINDS: readonly ActionKind[] = [
  'send',
  'edit_message',
  'delete_message',
  'add_reaction',
  'pin_message',
  'end_poll',
];

const NAMED = new Set<ActionKind>([
  ...MODERATION_KINDS,
  ...CHANNEL_KINDS,
  ...ROLE_KINDS,
  ...MESSAGE_KINDS,
]);

const TYPE_GROUPS: readonly { label: string; kinds: readonly ActionKind[] }[] = [
  { label: 'Moderation', kinds: MODERATION_KINDS },
  { label: 'Channels', kinds: CHANNEL_KINDS },
  { label: 'Roles', kinds: ROLE_KINDS },
  { label: 'Messages', kinds: MESSAGE_KINDS },
  { label: 'Other', kinds: ACTION_KINDS.filter((kind) => !NAMED.has(kind)) },
];

const SEVERE = new Set<string>(['ban', 'kick']);
const MARKED = new Set<string>(['warn', 'ban', 'kick', 'timeout']);

const NOTHING_RECORDED = 'No cases';
const NO_MATCH = 'No cases match these filters';

const REHEARSAL = 'Discord was not called — the case was recorded as a rehearsal.';

function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 86_400)}d`;

  return `${Math.floor(seconds / 31_536_000)}y`;
}

function When({ iso, now }: { iso: string; now: number }): ReactElement {
  const ms = now - Date.parse(iso);

  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ms < -60_000 ? `in ${span(-ms)}` : ms < 60_000 ? 'just now' : `${span(ms)} ago`}
    </time>
  );
}

function caseIdIssue(value: string): string | undefined {
  if (value === '') return undefined;

  const parsed = caseIdSchema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

function state(row: CaseRecord, now: number): ReactNode {
  if (row.revertedAt !== null) return <Badge tone="info">Reverted</Badge>;
  if (row.dryRun) return <Badge tone="neutral">Rehearsal</Badge>;
  if (row.expiresAt === null) return null;

  const at = Date.parse(row.expiresAt);

  if (at <= now) return <span className="text-muted">Expired</span>;

  return (
    <time dateTime={row.expiresAt} title={new Date(at).toLocaleString()}>
      Expires in {span(at - now)}
    </time>
  );
}

function Who({
  id,
  pending,
  absent,
}: {
  id: string | null;
  pending: boolean;
  absent: string;
}): ReactElement {
  const member = useMember(id);

  if (id === null) return <span className="text-muted">{absent}</span>;
  // A pseudo-actor (proton:rules) is not a member: MemberCell would show it as one who has left.
  if (!SNOWFLAKE.test(id)) return <span className="mono text-xs">{id}</span>;
  if (member === undefined && pending) return <Spinner label="Loading member" />;

  return <MemberCell userId={id} />;
}

interface TextFilter {
  draft: string;
  set: (value: string) => void;
  value: string | undefined;
  invalid: boolean;
  clear: () => void;
}

function useTextFilter(accepts: (value: string) => boolean, onCommit: () => void): TextFilter {
  const [draft, setDraft] = useState('');
  const [value, setValue] = useState<string | undefined>(undefined);

  const trimmed = draft.trim();
  const ok = trimmed === '' || accepts(trimmed);
  const wanted = trimmed === '' ? undefined : trimmed;

  useEffect(() => {
    if (!ok || wanted === value) return;

    const timer = window.setTimeout(() => {
      setValue(wanted);
      onCommit();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [ok, wanted, value, onCommit]);

  const clear = useCallback(() => {
    setDraft('');
    setValue(undefined);
  }, []);

  return { draft, set: setDraft, value, invalid: !ok, clear };
}

export function CaseLogArea({
  guildId,
  moduleId,
}: {
  guildId: string;
  moduleId: string;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);

  const { caseId, type, sort, direction, page } = caseLinkFilter(search);
  const pageRef = useRef(page);
  pageRef.current = page;

  const resetPage = useCallback(() => {
    if (pageRef.current !== 1) go({ page: undefined });
  }, [go]);

  const term = search.q ?? '';
  const [idDraft, setIdDraft] = useState(term);
  useEffect(() => setIdDraft(term), [term]);

  const trimmedId = idDraft.trim();
  const idIssue = caseIdIssue(trimmedId);

  useEffect(() => {
    const next = trimmedId === '' ? undefined : trimmedId;
    if ((next ?? '') === term || idIssue !== undefined) return;

    const timer = window.setTimeout(() => go({ q: next, page: undefined }), 250);
    return () => window.clearTimeout(timer);
  }, [trimmedId, term, idIssue, go]);

  const moderator = useTextFilter((value) => SNOWFLAKE.test(value), resetPage);
  const target = useTextFilter((value) => SNOWFLAKE.test(value), resetPage);
  const from = useTextFilter(() => true, resetPage);
  const to = useTextFilter(() => true, resetPage);

  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  const backwards =
    from.value !== undefined && to.value !== undefined && from.value > to.value
      ? RANGE_BACKWARDS
      : undefined;

  const query = useQuery(
    casesQuery(guildId, {
      caseId,
      type,
      moderatorId: moderator.value,
      targetId: target.value,
      from: backwards === undefined ? from.value : undefined,
      to: backwards === undefined ? to.value : undefined,
      sort,
      direction,
      page,
      pageSize,
    }),
  );

  const rows = query.data?.cases ?? [];
  const total = query.data?.total ?? 0;
  const now = Date.now();

  const selected = rows.find((row) => row.id === search.id);

  const memberIds = useMemo(() => {
    const ids = new Set<string>();

    const add = (id: string | null): void => {
      if (id !== null && SNOWFLAKE.test(id)) ids.add(id);
    };

    for (const row of rows) {
      add(row.targetId);
      add(row.moderatorId);
    }

    if (selected !== undefined) {
      add(selected.actorId);
      add(selected.revertedBy);
    }

    return [...ids];
  }, [rows, selected]);

  const members = useQuery(membersQuery(guildId, memberIds));
  // The query is disabled for an empty list, and a disabled query is pending forever.
  const resolving = memberIds.length > 0 && members.isPending;

  const filtered =
    caseId !== undefined ||
    type !== undefined ||
    moderator.value !== undefined ||
    target.value !== undefined ||
    from.value !== undefined ||
    to.value !== undefined;

  const clearAll = (): void => {
    setIdDraft('');
    moderator.clear();
    target.clear();
    from.clear();
    to.clear();
    go({ q: undefined, status: undefined, page: undefined });
  };

  const columns: Column<CaseRecord>[] = [
    {
      id: 'caseNumber',
      header: '#',
      sortField: 'caseNumber',
      align: 'right',
      width: 76,
      cell: (row) => <span className="mono text-xs">{row.caseNumber}</span>,
    },
    {
      id: 'type',
      header: 'Type',
      width: 148,
      cell: (row) =>
        MARKED.has(row.type) ? (
          <Badge tone={SEVERE.has(row.type) ? 'danger' : 'warning'}>
            {KIND_LABELS[row.type as ActionKind] ?? row.type}
          </Badge>
        ) : (
          (KIND_LABELS[row.type as ActionKind] ?? row.type)
        ),
    },
    {
      id: 'target',
      header: 'Member',
      primary: true,
      width: 190,
      cell: (row) => <Who id={row.targetId} pending={resolving} absent="—" />,
    },
    {
      id: 'moderator',
      header: 'Moderator',
      width: 190,
      cell: (row) => <Who id={row.moderatorId} pending={resolving} absent="—" />,
    },
    {
      id: 'reason',
      header: 'Reason',
      cell: (row) =>
        row.reason === null ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="cases-reason" title={row.reason}>
            {row.reason}
          </span>
        ),
    },
    {
      id: 'module',
      header: 'Module',
      width: 116,
      cell: (row) => <span className="text-muted">{row.moduleId}</span>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      sortField: 'createdAt',
      width: 116,
      cell: (row) => <When iso={row.createdAt} now={now} />,
    },
    {
      id: 'state',
      header: 'Status',
      width: 132,
      cell: (row) => state(row, now),
    },
  ];

  return (
    <MemberProvider guildId={guildId} userIds={memberIds}>
      {/* biome-ignore lint/complexity/noUselessFragments: MemberProvider takes ReactElement, not a list that may hold nulls */}
      <>
        <div className="table-toolbar">
          <SearchField
            className="cases-search"
            value={idDraft}
            onChange={setIdDraft}
            label="Search cases"
            placeholder="Case ID, like K7f3M2q"
          />
          {filtered ? (
            <Button className="push-right" tone="ghost" size="sm" onClick={clearAll}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {idIssue !== undefined ? <p className="cases-note text-danger text-xs">{idIssue}</p> : null}

        <div className="cases-filters">
          <Field label="Type">
            {(props) => (
              <Select
                {...props}
                width="md"
                value={type ?? ''}
                options={[
                  { value: '', label: 'Any type' },
                  ...TYPE_GROUPS.flatMap((group) =>
                    group.kinds.map((kind) => ({
                      value: kind,
                      label: KIND_LABELS[kind],
                      group: group.label,
                    })),
                  ),
                ]}
                onChange={(value) =>
                  go({
                    status: value === '' ? undefined : value,
                    page: undefined,
                  })
                }
              />
            )}
          </Field>

          <Field label="Moderator ID" error={moderator.invalid ? NOT_A_SNOWFLAKE : undefined}>
            {(props) => (
              <TextInput
                {...props}
                width="md"
                inputMode="numeric"
                spellCheck={false}
                invalid={moderator.invalid}
                value={moderator.draft}
                onChange={(event) => moderator.set(event.currentTarget.value)}
              />
            )}
          </Field>

          <Field label="Member ID" error={target.invalid ? NOT_A_SNOWFLAKE : undefined}>
            {(props) => (
              <TextInput
                {...props}
                width="md"
                inputMode="numeric"
                spellCheck={false}
                invalid={target.invalid}
                value={target.draft}
                onChange={(event) => target.set(event.currentTarget.value)}
              />
            )}
          </Field>

          <Field label="From" error={backwards}>
            {(props) => (
              <TextInput
                {...props}
                type="date"
                width="sm"
                invalid={backwards !== undefined}
                value={from.draft}
                onChange={(event) => from.set(event.currentTarget.value)}
              />
            )}
          </Field>

          <Field label="To">
            {(props) => (
              <TextInput
                {...props}
                type="date"
                width="sm"
                value={to.draft}
                onChange={(event) => to.set(event.currentTarget.value)}
              />
            )}
          </Field>
        </div>

        {memberIds.length > MEMBER_LOOKUP_MAX ? (
          <p className="cases-note text-muted text-xs">
            Only the first {MEMBER_LOOKUP_MAX} members on this page show by name. The rest show as
            IDs.
          </p>
        ) : null}

        {query.isError ? (
          <StatusBanner tone="danger" live="polite">
            {readFailure(query.error, 'this server’s case log')}
          </StatusBanner>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={query.isPending}
            loadingLabel="Loading cases"
            onRowClick={(row) => go({ id: row.id })}
            sort={{ field: sort, direction }}
            onSortChange={(next) =>
              go({ sort: next.field, dir: next.direction, page: undefined, id: undefined })
            }
            empty={
              filtered
                ? {
                    icon: 'magnifying-glass',
                    title: NO_MATCH,
                    body: (
                      <Button size="sm" onClick={clearAll}>
                        Clear filters
                      </Button>
                    ),
                  }
                : { icon: 'clipboard-text', title: NOTHING_RECORDED }
            }
            footer={
              <>
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  noun="cases"
                  onPageChange={(next) => go({ page: next })}
                />
                <Select
                  aria-label="Cases per page"
                  width="xs"
                  value={String(pageSize)}
                  options={PAGE_SIZES.map((size) => ({
                    value: String(size),
                    label: `${size} per page`,
                  }))}
                  onChange={(value) => {
                    setPageSize(Number(value));
                    resetPage();
                  }}
                />
              </>
            }
          />
        )}

        <CaseDialog
          row={selected}
          now={now}
          pending={resolving}
          onClose={() => go({ id: undefined })}
        />
      </>
    </MemberProvider>
  );
}

function CaseDialog({
  row,
  now,
  pending,
  onClose,
}: {
  row: CaseRecord | undefined;
  now: number;
  pending: boolean;
  onClose: () => void;
}): ReactElement | null {
  if (!row) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Case #${row.caseNumber}`}
      size="wide"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Pairs>
        <Pair label="Case ID">
          <span className="inline inline-8">
            <span className="mono text-xs">{row.id}</span>
            <Button
              tone="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(row.id);
              }}
            >
              Copy ID
            </Button>
          </span>
        </Pair>
        <Pair label="Type">{KIND_LABELS[row.type as ActionKind] ?? row.type}</Pair>
        <Pair label="Module">{row.moduleId}</Pair>
        <Pair label="Member">
          <Who id={row.targetId} pending={pending} absent="None" />
        </Pair>
        <Pair label="Moderator">
          <Who id={row.moderatorId} pending={pending} absent="None" />
        </Pair>
        <Pair label="Requested by">
          <Who id={row.actorId} pending={pending} absent="—" />
        </Pair>
        <Pair label="Reason">
          {row.reason === null ? (
            <span className="text-muted">No reason given</span>
          ) : (
            <span className="cases-wrap">{row.reason}</span>
          )}
        </Pair>
        <Pair label="Created">
          <When iso={row.createdAt} now={now} />
        </Pair>
        <Pair label="Expires">
          {row.expiresAt === null ? (
            <span className="text-muted">Never</span>
          ) : (
            <When iso={row.expiresAt} now={now} />
          )}
        </Pair>
        <Pair label="Reverted">
          {row.revertedAt === null ? (
            <span className="text-muted">No</span>
          ) : (
            <When iso={row.revertedAt} now={now} />
          )}
        </Pair>
        <Pair label="Reverted by">
          <Who id={row.revertedBy} pending={pending} absent="—" />
        </Pair>
        <Pair label="Rehearsal">{row.dryRun ? REHEARSAL : 'No'}</Pair>
      </Pairs>
    </Dialog>
  );
}
