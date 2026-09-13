import { normaliseTagName } from '@proton/module-tags/config';
import { TAG_PAGE_SIZE_DEFAULT, type TagSummary } from '@proton/module-tags/query';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import { Button, SearchField } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import type { IconName } from '../../components/ui/icon.tsx';
import { Pair, Pairs } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import { readFailure } from '../../lib/errors.ts';
import { libraryFilter, TAG_SEARCH_MAX, tagsQuery } from './queries.ts';

const SEARCH_TOO_LONG = `Search is capped at ${TAG_SEARCH_MAX} characters.`;

const AUTHORED_IN_DISCORD = 'Use /tags in Discord to create, edit and delete tags.';

const NO_MATCH_BODY = 'Search looks at tag names only.';

const unsubscribed = (): (() => void) => () => undefined;

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
  // The server renders in its own time zone; the viewer's is only known once hydrated.
  const title = useSyncExternalStore(
    unsubscribed,
    () => new Date(iso).toLocaleString(),
    () => undefined,
  );

  return (
    <time dateTime={iso} title={title} suppressHydrationWarning>
      {ms < 60_000 ? 'just now' : `${span(ms)} ago`}
    </time>
  );
}

function tagCommand(name: string): string {
  const normalised = normaliseTagName(name);
  return `/tag name:${normalised.ok ? normalised.name : name}`;
}

export function TagLibraryArea({
  guildId,
  moduleId,
}: {
  guildId: string;
  moduleId: string;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);

  const term = search.q ?? '';
  const [draft, setDraft] = useState(term);
  useEffect(() => setDraft(term), [term]);

  const trimmed = draft.trim();
  const tooLong = trimmed.length > TAG_SEARCH_MAX;

  useEffect(() => {
    const next = trimmed === '' ? undefined : trimmed;
    if ((next ?? '') === term || tooLong) return;

    const timer = window.setTimeout(() => go({ q: next, page: undefined, id: undefined }), 250);
    return () => window.clearTimeout(timer);
  }, [trimmed, term, tooLong, go]);

  // The store holds a dashed, lower-cased name and the service only lower-cases the needle, so a
  // typed space matches nothing. Worth saying only when normalising changed more than the case.
  const normalised = trimmed === '' ? undefined : normaliseTagName(trimmed);
  const dashed =
    normalised?.ok === true && normalised.name !== trimmed.toLowerCase()
      ? normalised.name
      : undefined;

  const filter = libraryFilter(search, tooLong);
  const { page, sort, direction } = filter;

  const query = useQuery(tagsQuery(guildId, filter));

  const rows = query.data?.tags ?? [];
  const total = query.data?.total ?? 0;
  const now = Date.now();

  const memberIds = useMemo(() => {
    const ids = new Set<string>();

    for (const row of rows) {
      ids.add(row.createdBy);
      if (row.updatedBy !== null) ids.add(row.updatedBy);
    }

    return [...ids];
  }, [rows]);

  const selected = rows.find((row) => row.name === search.id);
  const searching = term !== '';

  const clear = (): void => {
    setDraft('');
    go({ q: undefined, page: undefined, id: undefined });
  };

  const empty: { icon?: IconName | undefined; title: string; body?: ReactNode } =
    total > 0
      ? {
          icon: 'list',
          title: `Page ${page} is empty`,
          body: (
            <Button size="sm" onClick={() => go({ page: undefined })}>
              Back to first page
            </Button>
          ),
        }
      : searching
        ? { icon: 'magnifying-glass', title: 'No matching tags', body: NO_MATCH_BODY }
        : {
            icon: 'tag',
            title: 'No tags',
            body: (
              <>
                Create the first one with <span className="mono">/tags create</span>.
              </>
            ),
          };

  const columns: Column<TagSummary>[] = [
    {
      id: 'name',
      header: 'Name',
      sortField: 'name',
      primary: true,
      width: 200,
      cell: (row) => <span className="mono">{row.name}</span>,
    },
    {
      id: 'content',
      header: 'Text',
      cell: (row) => {
        const line = row.content.split('\n')[0] ?? '';

        return (
          <span className="tags-line" title={line}>
            {line}
          </span>
        );
      },
    },
    {
      id: 'uses',
      header: 'Uses',
      sortField: 'uses',
      align: 'right',
      width: 84,
      cell: (row) => row.uses,
    },
    {
      id: 'author',
      header: 'Created by',
      width: 180,
      cell: (row) => <MemberCell userId={row.createdBy} />,
    },
    {
      id: 'created',
      header: 'Created',
      sortField: 'createdAt',
      width: 110,
      cell: (row) => <When iso={row.createdAt} now={now} />,
    },
    {
      id: 'updated',
      header: 'Last edited',
      width: 210,
      cell: (row) =>
        row.updatedAt === row.createdAt ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="inline inline-6">
            <When iso={row.updatedAt} now={now} />
            {row.updatedBy !== null ? (
              <>
                <span className="text-muted">by</span>
                <MemberCell userId={row.updatedBy} />
              </>
            ) : null}
          </span>
        ),
    },
  ];

  return (
    <MemberProvider guildId={guildId} userIds={memberIds}>
      {/* biome-ignore lint/complexity/noUselessFragments: MemberProvider takes ReactElement, not a list that may hold nulls */}
      <>
        <div className="table-toolbar">
          <SearchField
            className="tags-search"
            value={draft}
            onChange={setDraft}
            label="Search tags"
            placeholder="Search tags…"
          />
          {searching ? (
            <Button className="push-right" tone="ghost" size="sm" onClick={clear}>
              Clear search
            </Button>
          ) : null}
        </div>

        {tooLong ? <p className="tags-note text-danger text-xs">{SEARCH_TOO_LONG}</p> : null}

        {!tooLong && dashed !== undefined ? (
          <p className="tags-note text-muted text-xs">
            Tag names have no spaces — try <span className="mono">{dashed}</span>.
          </p>
        ) : null}

        <p className="tags-note text-muted text-xs">{AUTHORED_IN_DISCORD}</p>

        {query.isError ? (
          <StatusBanner tone="danger" live="polite">
            {readFailure(query.error, 'this server’s tags')}
          </StatusBanner>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.name}
            loading={query.isPending}
            loadingLabel="Loading tags"
            onRowClick={(row) => go({ id: row.name })}
            sort={{ field: sort, direction }}
            onSortChange={(next) =>
              go({ sort: next.field, dir: next.direction, page: undefined, id: undefined })
            }
            empty={empty}
            footer={
              <Pagination
                page={page}
                pageSize={query.data?.pageSize ?? TAG_PAGE_SIZE_DEFAULT}
                total={total}
                noun="tags"
                onPageChange={(next) => go({ page: next, id: undefined })}
              />
            }
          />
        )}

        <TagDialog tag={selected} now={now} onClose={() => go({ id: undefined })} />
      </>
    </MemberProvider>
  );
}

function TagDialog({
  tag,
  now,
  onClose,
}: {
  tag: TagSummary | undefined;
  now: number;
  onClose: () => void;
}): ReactElement | null {
  // Held against the tag it belongs to rather than cleared in an effect: opening a different tag
  // would otherwise show "copied" for something the admin never copied.
  const [copied, setCopied] = useState<{ name: string; what: string } | null>(null);

  if (!tag) return null;

  const note = copied?.name === tag.name ? `${copied.what} copied` : undefined;

  const copy = (what: string, text: string): void => {
    void navigator.clipboard?.writeText(text);
    setCopied({ name: tag.name, what });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={tag.name}
      size="wide"
      footerNote={note}
      footer={
        <>
          <Button onClick={() => copy('Command', tagCommand(tag.name))}>Copy command</Button>
          <Button onClick={() => copy('Text', tag.content)}>Copy text</Button>
          <Button tone="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="stack stack-16">
        <p className="mono text-sm tags-command">{tagCommand(tag.name)}</p>

        <DiscordPreview message={{ content: tag.content }} />

        <Pairs>
          <Pair label="Created by">
            <MemberCell userId={tag.createdBy} />
          </Pair>
          <Pair label="Created">
            <When iso={tag.createdAt} now={now} />
          </Pair>
          <Pair label="Last edited by">
            <MemberCell userId={tag.updatedBy} fallback="None" />
          </Pair>
          <Pair label="Last edited">
            {tag.updatedAt === tag.createdAt ? (
              <span className="text-muted">Never edited</span>
            ) : (
              <When iso={tag.updatedAt} now={now} />
            )}
          </Pair>
          <Pair label="Uses">
            {tag.uses} time{tag.uses === 1 ? '' : 's'}
          </Pair>
        </Pairs>
      </div>
    </Dialog>
  );
}
