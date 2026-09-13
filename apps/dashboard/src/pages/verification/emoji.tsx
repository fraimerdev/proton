import { formatComponentEmoji, parseComponentEmoji } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import { Button, SearchField, TextInput } from '../../components/ui/controls.tsx';
import { Spinner } from '../../components/ui/feedback.tsx';
import { Popover } from '../../components/ui/overlay.tsx';
import { readFailure } from '../../lib/errors.ts';
import { emojisQuery } from '../../lib/queries.ts';

function cdnUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=44`;
}

export function EmojiField({
  guildId,
  value,
  maxLength,
  onChange,
}: {
  guildId: string;
  value: string | undefined;
  maxLength: number;
  onChange: (value: string | undefined) => void;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { data, error, isPending } = useQuery({ ...emojisQuery(guildId), enabled: open });

  const parsed = parseComponentEmoji(value);
  const needle = query.trim().toLowerCase();

  const offered = (data ?? []).filter(
    (emoji) => needle === '' || emoji.name.toLowerCase().includes(needle),
  );

  return (
    <span className="inline inline-8">
      <span className="verification-emoji-preview" aria-hidden>
        {parsed?.id ? (
          <img src={cdnUrl(parsed.id, parsed.animated === true)} alt="" />
        ) : (
          (parsed?.name ?? '—')
        )}
      </span>

      <TextInput
        width="sm"
        aria-label="Button emoji"
        placeholder="None"
        maxLength={maxLength}
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.currentTarget.value === '' ? undefined : event.currentTarget.value)
        }
      />

      <Button
        ref={anchor}
        size="sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setOpen((current) => !current);
        }}
      >
        Server emoji
      </Button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={280}
        maxWidth={320}
      >
        <div className="picker-search">
          <SearchField
            value={query}
            onChange={setQuery}
            label="Search emoji"
            placeholder="Search emoji…"
            autoFocus
          />
        </div>

        <div className="popover-scroll">
          {error ? (
            <p className="picker-note">{readFailure(error, 'this server’s emoji')}</p>
          ) : null}
          {isPending && !error ? (
            <p className="picker-note">
              <Spinner label="Loading emoji…" showLabel status />
            </p>
          ) : null}

          {!isPending && !error && offered.length === 0 ? (
            <p className="picker-note">
              {needle === '' ? 'No custom emoji.' : 'No matching emoji'}
            </p>
          ) : null}

          <div className="emoji-grid" role="listbox" aria-label="Server emoji">
            {offered.map((emoji) => (
              <button
                key={emoji.id}
                type="button"
                role="option"
                aria-selected={parsed?.id === emoji.id}
                className="emoji-cell"
                title={`:${emoji.name}:`}
                onClick={() => {
                  onChange(
                    formatComponentEmoji({
                      name: emoji.name,
                      id: emoji.id,
                      ...(emoji.animated ? { animated: true } : {}),
                    }),
                  );
                  setOpen(false);
                }}
              >
                <img src={cdnUrl(emoji.id, emoji.animated)} alt={`:${emoji.name}:`} />
              </button>
            ))}
          </div>
        </div>
      </Popover>

      {value !== undefined ? (
        <Button tone="ghost" size="sm" onClick={() => onChange(undefined)}>
          Clear
        </Button>
      ) : null}
    </span>
  );
}
