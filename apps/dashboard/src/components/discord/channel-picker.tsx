import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import type { GuildChannel } from '../../lib/discord.ts';
import { readFailure } from '../../lib/errors.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { useRecent } from '../ui/collection.tsx';
import { Chip, cx, SearchField } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { Icon, type IconName } from '../ui/icon.tsx';
import { Popover } from '../ui/overlay.tsx';

// Verified against docs.discord.com/developers/resources/channel: the numeric channel types.
export const CHANNEL_TYPE = {
  text: 0,
  dm: 1,
  voice: 2,
  groupDm: 3,
  category: 4,
  announcement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  stage: 13,
  directory: 14,
  forum: 15,
  media: 16,
} as const;

const CHANNEL_ICON: Record<number, IconName> = {
  0: 'hash',
  2: 'speaker-high',
  4: 'folder-simple',
  5: 'megaphone',
  10: 'chat-teardrop-text',
  11: 'chat-teardrop-text',
  12: 'chat-teardrop-text',
  13: 'microphone-stage',
  15: 'list-checks',
  16: 'image',
};

export function channelIcon(type: number): IconName {
  return CHANNEL_ICON[type] ?? 'hash';
}

/** Text-like destinations Proton can post into. The default for anything that sends a message. */
export const POSTABLE_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
  CHANNEL_TYPE.announcementThread,
] as const;

/**
 * The guild's channels as a lookup, with the one fact every caller kept dropping: whether the list
 * has arrived yet. Without it a miss is indistinguishable from a channel that was deleted, and the
 * row prints a raw snowflake on first paint.
 */
export function useChannelIndex(guildId: string): {
  byId: ReadonlyMap<string, GuildChannel>;
  pending: boolean;
} {
  const { data, isPending } = useQuery(channelsQuery(guildId));

  const byId = useMemo(() => new Map((data ?? []).map((channel) => [channel.id, channel])), [data]);

  return { byId, pending: isPending };
}

/**
 * Resolves the id itself when given a guild, so a row never flashes a raw snowflake while the
 * channel list is still in flight — an id is shown only once Proton knows the channel is gone.
 */
export function ChannelName({
  channel,
  id,
  guildId,
}: {
  channel?: GuildChannel | undefined;
  id?: string | null | undefined;
  guildId?: string | undefined;
}): ReactElement {
  const { data, isPending } = useQuery({
    ...channelsQuery(guildId ?? ''),
    enabled: guildId !== undefined && channel === undefined && Boolean(id),
  });

  const found = channel ?? (id ? data?.find((candidate) => candidate.id === id) : undefined);

  if (!found) {
    if (!id) return <span className="text-muted">None</span>;
    if (guildId !== undefined && isPending) return <Spinner label="Loading channel" />;

    return (
      <span
        className="text-muted mono"
        title="Proton cannot find this channel — it may have been deleted."
      >
        {id}
      </span>
    );
  }

  return (
    <span className="inline inline-6 truncate">
      <Icon name={channelIcon(found.type)} size={14} className="picker-option-icon" />
      <span className="truncate">{found.name}</span>
    </span>
  );
}

interface ChannelPickerProps {
  guildId: string;
  value: string | null | undefined;
  onChange: (channelId: string | null) => void;
  /** Only these Discord channel types are offered. Defaults to text-like destinations. */
  types?: readonly number[] | undefined;
  placeholder?: string | undefined;
  allowNone?: boolean | undefined;
  noneLabel?: string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  width?: number | string | undefined;
  label?: string | undefined;
  /** 'add' draws a small plus button that sits at the end of a chip list. */
  trigger?: 'field' | 'add' | undefined;
}

export function ChannelMultiPicker({
  guildId,
  value,
  onChange,
  types = POSTABLE_CHANNEL_TYPES,
  max,
  label = 'Add channel',
  disabled = false,
  invalid = false,
}: {
  guildId: string;
  value: readonly string[];
  onChange: (channelIds: string[]) => void;
  types?: readonly number[] | undefined;
  max?: number | undefined;
  label?: string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
}): ReactElement {
  const { byId, pending } = useChannelIndex(guildId);
  const atMax = max !== undefined && value.length >= max;
  const recent = useRecent();

  return (
    <div className="chip-list">
      {value.map((id) => {
        const channel = byId.get(id);
        const name = channel?.name ?? (pending ? 'channel' : id);

        return (
          <Chip
            key={id}
            className={recent.enter(id, 'part')}
            removeLabel={`Remove ${name}`}
            onRemove={disabled ? undefined : () => onChange(value.filter((held) => held !== id))}
          >
            <ChannelName channel={channel} id={id} guildId={guildId} />
          </Chip>
        );
      })}

      <ChannelPicker
        guildId={guildId}
        value={null}
        allowNone={false}
        trigger="add"
        disabled={disabled || atMax}
        invalid={invalid}
        label={atMax ? `${label} (limit of ${max} reached)` : label}
        types={types}
        onChange={(next) => {
          if (next === null || atMax || value.includes(next)) return;
          recent.mark(next);
          onChange([...value, next]);
        }}
      />
    </div>
  );
}

export function ChannelPicker({
  guildId,
  value,
  onChange,
  types = POSTABLE_CHANNEL_TYPES,
  placeholder = 'Choose a channel',
  allowNone = true,
  noneLabel = 'No channel',
  disabled = false,
  invalid = false,
  width = 252,
  label,
  trigger = 'field',
}: ChannelPickerProps): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { data, error, isPending } = useQuery({
    ...channelsQuery(guildId),
    enabled: open || value != null,
  });

  const channels = useMemo(() => data ?? [], [data]);
  const selected = channels.find((channel) => channel.id === value);

  const offered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return channels.filter(
      (channel) =>
        types.includes(channel.type) &&
        (needle === '' || channel.name.toLowerCase().includes(needle)),
    );
  }, [channels, types, query]);

  // Grouped under their category, the way Discord's own sidebar reads.
  const groups = useMemo(() => {
    const byParent = new Map<string, { name: string | null; channels: GuildChannel[] }>();

    for (const channel of offered) {
      const key = channel.parentId ?? '';
      const group = byParent.get(key) ?? { name: channel.parentName, channels: [] };
      group.channels.push(channel);
      byParent.set(key, group);
    }

    return [...byParent.values()];
  }, [offered]);

  return (
    <>
      {trigger === 'add' ? (
        <button
          ref={anchor}
          type="button"
          className="chip-add"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-invalid={invalid ? true : undefined}
          aria-label={label ?? placeholder}
          title={label ?? placeholder}
          onClick={() => {
            setQuery('');
            setOpen((current) => !current);
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      ) : (
        <button
          ref={anchor}
          type="button"
          className="picker-trigger"
          style={{ width }}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-invalid={invalid ? true : undefined}
          aria-label={label}
          onClick={() => {
            setQuery('');
            setOpen((current) => !current);
          }}
        >
          <span className="picker-value">
            {selected ? (
              <ChannelName channel={selected} />
            ) : value && isPending ? (
              <Spinner label="Loading channel" />
            ) : value ? (
              <span className="mono text-muted">{value}</span>
            ) : (
              <span className="picker-placeholder">{placeholder}</span>
            )}
          </span>
          <Icon name="caret-down" size={12} weight="fill" className="picker-chevron" />
        </button>
      )}

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={280}
        maxWidth={360}
      >
        <div className="picker-search">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search channels…"
            label="Search channels"
            autoFocus
          />
        </div>

        <div className="popover-scroll" role="listbox">
          {allowNone ? (
            <button
              type="button"
              role="option"
              aria-selected={value == null}
              className="picker-option"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <Icon name="prohibit" size={15} className="picker-option-icon" />
              {noneLabel}
            </button>
          ) : null}

          {error ? (
            <p className="picker-note">{readFailure(error, 'this server’s channels')}</p>
          ) : null}
          {isPending && !error ? (
            <p className="picker-note">
              <Spinner label="Loading channels…" showLabel status />
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.name ?? '—'}>
              {group.name !== null ? (
                <p className="picker-category">
                  <Icon name="folder-simple" size={11} />
                  {group.name}
                </p>
              ) : null}
              {group.channels.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  role="option"
                  aria-selected={channel.id === value}
                  className={cx('picker-option')}
                  onClick={() => {
                    onChange(channel.id);
                    setOpen(false);
                  }}
                >
                  <Icon name={channelIcon(channel.type)} size={15} className="picker-option-icon" />
                  <span className="truncate">{channel.name}</span>
                  {channel.id === value ? (
                    <Icon name="check" size={13} weight="fill" className="menu-item-check" />
                  ) : null}
                </button>
              ))}
            </div>
          ))}

          {!isPending && !error && offered.length === 0 ? (
            <p className="picker-note">
              {query.trim() === '' ? 'No channels Proton can use here.' : 'No matching channels'}
            </p>
          ) : null}
        </div>
      </Popover>
    </>
  );
}
