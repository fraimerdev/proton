import type { ComponentEmoji } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { readFailure } from '../../lib/errors.ts';
import { emojisQuery } from '../../lib/queries.ts';
import { cx, SearchField } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover } from '../ui/overlay.tsx';

// 1900 emoji with their names is ~90 kB of table. Behind a dynamic import it is fetched the first
// time somebody opens the picker rather than sitting in the bundle every page load pays for.
const UnicodeTable = lazy(() => import('./unicode-table.tsx'));

export function emojiUrl(emoji: ComponentEmoji): string | null {
  if (!emoji.id) return null;
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'webp'}?size=44`;
}

export function EmojiGlyph({
  emoji,
  size = 18,
}: {
  emoji: ComponentEmoji | undefined | null;
  size?: number | undefined;
}): ReactElement | null {
  if (!emoji) return null;

  const url = emojiUrl(emoji);
  if (url) {
    return <img src={url} alt={emoji.name ?? ''} width={size} height={size} />;
  }

  return <span style={{ fontSize: size, lineHeight: 1 }}>{emoji.name}</span>;
}

interface EmojiPickerProps {
  guildId: string;
  value: ComponentEmoji | undefined | null;
  onChange: (emoji: ComponentEmoji | null) => void;
  label?: string | undefined;
  disabled?: boolean | undefined;
}

export function EmojiPicker({
  guildId,
  value,
  onChange,
  label = 'Emoji',
  disabled = false,
}: EmojiPickerProps): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'server' | 'unicode'>('server');

  const {
    data: guildEmojis,
    error,
    isPending,
  } = useQuery({ ...emojisQuery(guildId), enabled: open });

  const needle = query.trim().toLowerCase();

  const server = useMemo(
    () =>
      (guildEmojis ?? []).filter(
        (emoji) => needle === '' || emoji.name.toLowerCase().includes(needle),
      ),
    [guildEmojis, needle],
  );

  const pick = (emoji: ComponentEmoji | null): void => {
    onChange(emoji);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="picker-trigger"
        style={{ width: 64, justifyContent: 'center' }}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setQuery('');
          setOpen((current) => !current);
        }}
      >
        {value ? (
          <EmojiGlyph emoji={value} />
        ) : (
          <Icon name="smiley" size={17} className="text-muted" />
        )}
        <Icon name="caret-down" size={11} weight="fill" className="picker-chevron" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={324}
        maxWidth={324}
      >
        <div className="picker-search">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search emoji…"
            label="Search emoji"
            autoFocus
          />
        </div>

        <div className="emoji-tabs" role="tablist" aria-label="Emoji source">
          <button
            type="button"
            role="tab"
            className={cx('emoji-tab')}
            aria-selected={tab === 'server'}
            title="Server emoji"
            onClick={() => setTab('server')}
          >
            <Icon name="users-three" size={15} />
          </button>
          <button
            type="button"
            role="tab"
            className="emoji-tab"
            aria-selected={tab === 'unicode'}
            title="Standard emoji"
            onClick={() => setTab('unicode')}
          >
            <Icon name="smiley" size={15} />
          </button>
          {value ? (
            <button
              type="button"
              className="menu-item push-right"
              style={{ width: 'auto' }}
              onClick={() => pick(null)}
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="popover-scroll">
          {tab === 'server' ? (
            isPending ? (
              <p className="picker-note">
                <Spinner label="Loading emoji…" showLabel status />
              </p>
            ) : error ? (
              <p className="picker-note">{readFailure(error, 'this server’s emoji')}</p>
            ) : server.length === 0 ? (
              <p className="picker-note">
                {needle === '' ? 'No custom emoji.' : 'No matching emoji'}
              </p>
            ) : (
              <div className="emoji-grid">
                {server.map((emoji) => (
                  <button
                    key={emoji.id}
                    type="button"
                    className="emoji-cell"
                    title={`:${emoji.name}:`}
                    onClick={() =>
                      pick({ id: emoji.id, name: emoji.name, animated: emoji.animated })
                    }
                  >
                    <EmojiGlyph
                      emoji={{ id: emoji.id, name: emoji.name, animated: emoji.animated }}
                      size={22}
                    />
                  </button>
                ))}
              </div>
            )
          ) : (
            <Suspense
              fallback={
                <p className="picker-note">
                  <Spinner label="Loading emoji…" showLabel fallback status />
                </p>
              }
            >
              <UnicodeTable
                query={needle}
                onPick={(char) => pick({ name: char, animated: false })}
              />
            </Suspense>
          )}
        </div>
      </Popover>
    </>
  );
}
