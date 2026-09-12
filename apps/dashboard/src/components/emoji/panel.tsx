import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Icon } from '../shell/icon.tsx';
import { useEmojiCatalog } from './catalog.tsx';
import { EMOJI_GROUPS } from './emoji-set.gen.ts';
import { emojiImageUrl } from './glyph.tsx';

// Fixed rather than measured, so the arrow keys can move a whole row without asking the grid how
// wide it happens to be this render. The panel is sized from it, not the other way round.
const COLUMNS = 9;

const GUILD_SECTION = 'guild';

interface Cell {
  key: string;
  // What gets stored: the bare character, or <:name:id> for a custom one.
  value: string;
  name: string;
  url?: string;
}

interface Section {
  id: string;
  label: string;
  icon: string;
  iconUrl?: string;
  cells: readonly Cell[];
}

function customCell(emoji: { id: string; name: string; animated: boolean }): Cell {
  return {
    key: emoji.id,
    value: `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`,
    name: emoji.name,
    url: emojiImageUrl(emoji.id, emoji.animated),
  };
}

function matches(name: string, needle: string): boolean {
  return name.toLowerCase().includes(needle);
}

export function buildSections(
  catalog: ReturnType<typeof useEmojiCatalog>,
  query: string,
): readonly Section[] {
  const needle = query.trim().toLowerCase().replace(/^:|:$/g, '');

  const guild: Section | null =
    catalog.emojis.length === 0
      ? null
      : {
          id: GUILD_SECTION,
          label: catalog.guildName,
          icon: '🏠',
          ...(catalog.guildIcon ? { iconUrl: catalog.guildIcon } : {}),
          cells: catalog.emojis
            .filter((emoji) => !needle || matches(emoji.name, needle))
            .map(customCell),
        };

  const unicode = EMOJI_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    icon: group.icon,
    cells: group.emojis
      .filter((emoji) => !needle || matches(emoji.name, needle))
      .map((emoji) => ({ key: emoji.char, value: emoji.char, name: emoji.name })),
  }));

  // A section with nothing in it is dropped rather than drawn empty: while searching, that is most
  // of them, and nine headings over nothing is not a result list.
  return [...(guild ? [guild] : []), ...unicode].filter((section) => section.cells.length > 0);
}

export interface EmojiPickerProps {
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
}

export function EmojiPicker({
  value,
  onSelect,
  onClose,
  panelRef,
}: EmojiPickerProps): ReactElement {
  const catalog = useEmojiCatalog();
  const searchId = useId();

  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Cell | null>(null);

  const search = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sectionTops = useRef(new Map<string, HTMLElement>());

  const sections = useMemo(() => buildSections(catalog, query), [catalog, query]);
  const [current, setCurrent] = useState(sections[0]?.id ?? '');

  useEffect(() => search.current?.focus(), []);

  // The rail highlight follows the scroll rather than the last click, or it goes stale the moment
  // somebody uses the wheel instead of the rail.
  const onScroll = useCallback(() => {
    const box = scroll.current;
    if (!box) return;

    let top = '';
    for (const [id, element] of sectionTops.current) {
      if (element.offsetTop - box.scrollTop <= 12) top = id;
    }

    if (top) setCurrent(top);
  }, []);

  function jump(id: string): void {
    const element = sectionTops.current.get(id);
    const box = scroll.current;
    if (!element || !box) return;

    box.scrollTo({ top: element.offsetTop });
    setCurrent(id);
  }

  // Roving arrows over the whole grid, read off the DOM rather than an index into `sections`: the
  // cells are the same order, and reading them back is what keeps the two from drifting.
  function moveFocus(from: HTMLElement, by: number): void {
    const cells = [...(scroll.current?.querySelectorAll<HTMLElement>('.emoji-cell') ?? [])];
    const at = cells.indexOf(from);
    if (at === -1) return;

    const next = cells[Math.min(Math.max(at + by, 0), cells.length - 1)];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  }

  // On the cell rather than delegated from the scroller: the scroller is a plain div, and a key
  // handler on one is a control a keyboard can reach but a screen reader is never told about.
  function onCellKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const target = event.currentTarget;

    const by =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? COLUMNS
            : event.key === 'ArrowUp'
              ? -COLUMNS
              : 0;

    if (by === 0) return;

    event.preventDefault();
    moveFocus(target, by);
  }

  return (
    // Escape listens on the panel rather than the input: one Tab moves focus into the grid, and
    // from there the key that closes the picker stopped working.
    <div
      className="emoji-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Pick an emoji"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="emoji-search">
        <Icon name="magnifying-glass" />
        <input
          ref={search}
          id={searchId}
          type="text"
          value={query}
          placeholder="Search emoji"
          aria-label="Search emoji"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="emoji-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery('');
              search.current?.focus();
            }}
          >
            <Icon name="x" />
          </button>
        ) : null}
      </div>

      <div className="emoji-body">
        <nav className="emoji-rail" aria-label="Emoji categories">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className="emoji-rail-button"
              aria-label={section.label}
              aria-current={section.id === current ? 'true' : undefined}
              onClick={() => jump(section.id)}
            >
              {section.iconUrl ? (
                <img src={section.iconUrl} alt="" width={20} height={20} />
              ) : (
                <span aria-hidden="true">{section.icon}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="emoji-scroll" ref={scroll} onScroll={onScroll}>
          {sections.map((section) => (
            <section
              className="emoji-section"
              key={section.id}
              ref={(element) => {
                if (element) sectionTops.current.set(section.id, element);
                else sectionTops.current.delete(section.id);
              }}
            >
              <h3 className="emoji-section-head">{section.label}</h3>
              <div className="emoji-grid">
                {section.cells.map((cell) => (
                  <button
                    key={cell.key}
                    type="button"
                    className="emoji-cell"
                    title={`:${cell.name}:`}
                    aria-label={cell.name}
                    aria-pressed={cell.value === value}
                    onMouseEnter={() => setPreview(cell)}
                    onFocus={() => setPreview(cell)}
                    onKeyDown={onCellKeyDown}
                    onClick={() => onSelect(cell.value)}
                  >
                    {cell.url ? (
                      <img src={cell.url} alt="" width={24} height={24} loading="lazy" />
                    ) : (
                      <span aria-hidden="true">{cell.value}</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}

          {sections.length === 0 ? (
            <p className="emoji-empty">
              No emoji matches that. Search covers this server’s emoji and every unicode one by
              name.
            </p>
          ) : null}
        </div>
      </div>

      <div className="emoji-preview">
        {preview ? (
          <>
            {preview.url ? (
              <img src={preview.url} alt="" width={28} height={28} />
            ) : (
              <span className="emoji-preview-char" aria-hidden="true">
                {preview.value}
              </span>
            )}
            <span className="emoji-preview-name mono">:{preview.name.replace(/\s+/g, '_')}:</span>
          </>
        ) : (
          <span className="emoji-preview-idle">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}
