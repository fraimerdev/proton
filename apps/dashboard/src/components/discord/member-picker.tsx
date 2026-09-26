import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { GuildMember } from '../../lib/discord.ts';
import { readFailure } from '../../lib/errors.ts';
import { memberSearchQuery, membersQuery } from '../../lib/queries.ts';
import { SearchField } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover } from '../ui/overlay.tsx';

const MEMBER_ID = /^\d{17,20}$/;
const SEARCH_DELAY_MS = 250;
const SEARCH_MAX = 64;

function Avatar({ member }: { member: GuildMember }): ReactElement {
  return member.avatarUrl ? (
    <img className="user-avatar" src={member.avatarUrl} alt="" width={22} height={22} />
  ) : (
    <span className="user-avatar avatar-fallback" aria-hidden>
      {[...member.displayName].slice(0, 2).join('')}
    </span>
  );
}

export function MemberPicker({
  guildId,
  value,
  onChange,
  label,
  placeholder = 'Choose a member',
  noneLabel,
  width = 252,
}: {
  guildId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  placeholder?: string | undefined;
  noneLabel?: string | undefined;
  width?: number | string | undefined;
}): ReactElement {
  const queryClient = useQueryClient();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');

  const term = draft.trim().slice(0, SEARCH_MAX);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(term), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [term]);

  const pasted = MEMBER_ID.test(query) ? query : null;

  const current = useQuery(membersQuery(guildId, value === null ? [] : [value]));
  const searched = useQuery({
    ...memberSearchQuery(guildId, query),
    enabled: open && query !== '' && pasted === null,
    placeholderData: keepPreviousData,
  });
  const looked = useQuery({
    ...membersQuery(guildId, pasted === null ? [] : [pasted]),
    enabled: open && pasted !== null,
  });

  const active = pasted === null ? searched : looked;
  const found = (active.data ?? []).filter((member) => !member.bot);
  const waiting = term !== query || active.isPending;
  const selected = current.data?.find((member) => member.id === value);

  const pick = (next: GuildMember | null): void => {
    if (next !== null) {
      queryClient.setQueryData(membersQuery(guildId, [next.id]).queryKey, [next]);
    }
    onChange(next === null ? null : next.id);
    setOpen(false);
    setDraft('');
  };

  return (
    <div className="stack stack-4" style={{ width, maxWidth: '100%' }}>
      <button
        ref={anchor}
        type="button"
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setDraft('');
          setOpen((was) => !was);
        }}
      >
        <span className="picker-value">
          {selected ? (
            <span className="user-cell">
              <Avatar member={selected} />
              <span className="user-name">{selected.displayName}</span>
            </span>
          ) : value !== null && current.isPending ? (
            <Spinner label="Loading member" />
          ) : value !== null ? (
            <span className="mono text-muted">{value}</span>
          ) : (
            <span className="picker-placeholder">{placeholder}</span>
          )}
        </span>
        <Icon name="caret-down" size={12} weight="fill" className="picker-chevron" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={260}
        maxWidth={340}
      >
        <div className="picker-search">
          <SearchField
            value={draft}
            onChange={setDraft}
            placeholder="Search by name or ID…"
            label="Search members"
            autoFocus
          />
        </div>

        <div className="popover-scroll" role="listbox">
          {noneLabel !== undefined ? (
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className="picker-option"
              onClick={() => pick(null)}
            >
              <Icon name="prohibit" size={15} className="picker-option-icon" />
              {noneLabel}
            </button>
          ) : null}

          {term === '' ? (
            <p className="picker-note">Type a name or paste a member ID.</p>
          ) : active.isError ? (
            <p className="picker-note">{readFailure(active.error, 'this server’s members')}</p>
          ) : found.length === 0 && waiting ? (
            <p className="picker-note">
              <Spinner label="Searching…" showLabel status />
            </p>
          ) : found.length === 0 ? (
            <p className="picker-note">No matching members</p>
          ) : (
            found.map((member) => (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={member.id === value}
                className="picker-option"
                onClick={() => pick(member)}
              >
                <Avatar member={member} />
                <span className="user-name">{member.displayName}</span>
                <span className="text-xs text-muted truncate">{member.username}</span>
                {member.id === value ? (
                  <Icon name="check" size={13} weight="fill" className="menu-item-check" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </Popover>
    </div>
  );
}
