import {
  type CSSProperties,
  Fragment,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { optionLabel } from '../../lib/enum-labels.ts';
import { useDismiss } from '../shell/dismiss.ts';
import { Icon } from '../shell/icon.tsx';
import type { IconName } from '../shell/icon-set.gen.ts';

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parentName?: string | null | undefined;
}

export interface DiscordRole {
  id: string;
  name: string;
  position: number;
  color?: number;
}

const CHANNEL_ICON_FALLBACK: IconName = 'hash';

const CHANNEL_ICONS: Record<number, IconName> = {
  0: 'hash',
  2: 'speaker-high',
  4: 'folder',
  5: 'megaphone',
  13: 'microphone-stage',
  15: 'chats-circle',
  16: 'chats-circle',
};

export const CHANNEL_ICON_NAMES: readonly IconName[] = [
  ...new Set([...Object.values(CHANNEL_ICONS), CHANNEL_ICON_FALLBACK]),
];

export function channelIcon(type: number): IconName {
  return Object.hasOwn(CHANNEL_ICONS, type)
    ? (CHANNEL_ICONS[type] ?? CHANNEL_ICON_FALLBACK)
    : CHANNEL_ICON_FALLBACK;
}

// Discord sends 0 for "no colour", which renders as the default member grey rather than black.
export function roleStyle(color: number | undefined): CSSProperties | undefined {
  if (!color) return undefined;

  const hex = `#${color.toString(16).padStart(6, '0')}`;
  const rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16));

  return {
    '--role-color': hex,
    '--role-wash': `rgba(${rgb.join(', ')}, 0.16)`,
    '--role-text': hex,
  } as CSSProperties;
}

export interface PickerOption {
  id: string;
  label: string;
  colour?: number | undefined;
  icon?: IconName | undefined;
  group?: string | undefined;

  // Stamped by channelOptions alone, so every channel list — generated form and hand-built panel
  // both — carries the note explaining why a channel somebody expected is not in it.
  kind?: 'channel' | undefined;
}

export const CHANNEL_NOTE = 'Channels Proton cannot see are not listed.';

export function roleOptions(roles: readonly DiscordRole[]): PickerOption[] {
  return roles.map((role) => ({ id: role.id, label: role.name, colour: role.color }));
}

export function channelOptions(
  channels: readonly DiscordChannel[],
  types?: readonly number[] | undefined,
): PickerOption[] {
  return channels
    .filter((channel) => types === undefined || types.includes(channel.type))
    .map((channel) => ({
      id: channel.id,
      label: channel.name,
      kind: 'channel' as const,
      icon: channelIcon(channel.type),
      ...(channel.parentName ? { group: channel.parentName } : {}),
    }));
}

export function enumOptions(
  values: readonly string[],
  labels?: Record<string, string> | undefined,
): PickerOption[] {
  return values.map((value) => ({ id: value, label: optionLabel(value, labels) }));
}

function Mark({ option }: { option: PickerOption }): ReactElement {
  return option.icon === undefined ? (
    <span className="pick-dot" style={roleStyle(option.colour)} />
  ) : (
    <Icon name={option.icon} className="pick-icon" />
  );
}

interface Group {
  label: string | undefined;
  options: PickerOption[];
}

function grouped(options: readonly PickerOption[]): Group[] {
  const out: Group[] = [];

  for (const option of options) {
    const last = out.at(-1);

    if (last && last.label === option.group) last.options.push(option);
    else out.push({ label: option.group, options: [option] });
  }

  return out;
}

interface PopoverProps {
  options: readonly PickerOption[];
  selected: readonly string[];
  multiple: boolean;
  label: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

function Popover({
  options,
  selected,
  multiple,
  label,
  onPick,
  onClose,
}: PopoverProps): ReactElement {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return needle === ''
      ? [...options]
      : options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  // Clamped rather than reset in an effect: filtering can shrink the list under the cursor, and a
  // stale index would leave Enter picking nothing on a list that plainly has matches.
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const current = matches[index];

  useEffect(() => inputRef.current?.focus(), []);

  // Focus never leaves the search box, so nothing scrolls the list on its own: a guild with more
  // channels than the 244px box shows would move aria-activedescendant onto a row the user cannot
  // see, and arrowing down would look like it had stopped working.
  const activeId = current ? `${listId}-${current.id}` : undefined;
  useEffect(() => {
    if (!activeId) return;

    listRef.current
      ?.querySelector(`[id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function move(step: number): void {
    if (matches.length === 0) return;
    setActive((matches.length + index + step) % matches.length);
  }

  function pick(id: string): void {
    onPick(id);
    if (!multiple) onClose();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current) pick(current.id);
    }
  }

  function row(option: PickerOption): ReactElement {
    const chosen = selected.includes(option.id);

    return (
      <div
        key={option.id}
        id={`${listId}-${option.id}`}
        className="picker-option"
        role="option"
        tabIndex={-1}
        aria-selected={chosen}
        data-active={current?.id === option.id || undefined}
        onMouseEnter={() => setActive(matches.indexOf(option))}
        // Down rather than click, so the search box keeps focus and picking a second role needs no
        // second trip to the keyboard.
        onMouseDown={(event) => {
          event.preventDefault();
          pick(option.id);
        }}
        onKeyDown={() => undefined}
      >
        <Mark option={option} />
        <span className="picker-option-label">{option.label}</span>
        {chosen ? <Icon name="check-circle" weight="fill" className="picker-tick" /> : null}
      </div>
    );
  }

  return (
    <div className="picker-pop">
      <div className="picker-search">
        <Icon name="magnifying-glass" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={`Search ${label}`}
          aria-activedescendant={activeId}
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div
        className="picker-list"
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
      >
        {grouped(matches).map((group, position) =>
          group.label === undefined ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: groups are positional, not identified
            <Fragment key={position}>{group.options.map(row)}</Fragment>
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: a listbox groups options with role=group — a fieldset inside one is not a thing
            <div className="picker-group" key={group.label} role="group" aria-label={group.label}>
              <span className="picker-group-name">{group.label}</span>
              {group.options.map(row)}
            </div>
          ),
        )}

        {matches.length === 0 ? <p className="picker-empty">Nothing matches that.</p> : null}
      </div>

      {options.some((option) => option.kind === 'channel') ? (
        <p className="picker-note">{CHANNEL_NOTE}</p>
      ) : null}
    </div>
  );
}

export interface SinglePickerProps {
  id: string;
  label: string;
  options: readonly PickerOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  emptyLabel: string;
  clearable: boolean;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
}

export function SinglePicker({
  id,
  label,
  options,
  value,
  onChange,
  emptyLabel,
  clearable,
  invalid,
  describedBy,
}: SinglePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, close, wrap, trigger);

  const known = options.find((option) => option.id === value);

  // A saved id the guild no longer has still governs what Proton does, and rendering it as "No
  // channel" hid a live setting behind the word for its absence. The token list already keeps its
  // unknown values under the raw id for the same reason.
  const missing = known === undefined && value !== null && value !== '';
  const chosen = known ?? (missing && value !== null ? { id: value, label: value } : undefined);

  const offered = useMemo(
    () => (clearable ? [{ id: '', label: emptyLabel }, ...options] : options),
    [clearable, emptyLabel, options],
  );

  return (
    <span className="picker" ref={wrap}>
      <button
        type="button"
        id={id}
        ref={trigger}
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        // A <label for> does not name a button, so without this every picker in the product
        // announced itself as whatever channel it happened to be set to.
        aria-label={
          missing
            ? `${label}: ${value}, which Proton cannot find in this server`
            : `${label}: ${chosen ? chosen.label : emptyLabel}`
        }
        data-unknown={missing || undefined}
        onClick={() => setOpen((was) => !was)}
      >
        {known ? <Mark option={known} /> : null}
        <span className={chosen ? 'picker-value' : 'picker-value picker-value-unset'}>
          {chosen ? chosen.label : emptyLabel}
        </span>
        <Icon name="caret-down" className="picker-caret" />
      </button>

      {open ? (
        <Popover
          options={offered}
          selected={value === null ? [] : [value]}
          multiple={false}
          label={label}
          onPick={(picked) => onChange(picked === '' ? null : picked)}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}

function Token({
  option,
  marked,
  unknown,
  onRemove,
}: {
  option: PickerOption;
  marked: boolean;
  unknown: boolean;
  onRemove: () => void;
}): ReactElement {
  return (
    <span className="token" data-unknown={unknown || undefined}>
      {marked ? <Mark option={option} /> : null}
      <span className="token-label">{option.label}</span>
      <button
        type="button"
        className="token-remove"
        aria-label={`Remove ${option.label}`}
        onClick={onRemove}
      >
        <Icon name="x" />
      </button>
    </span>
  );
}

export interface TokenPickerProps {
  label: string;
  options: readonly PickerOption[];
  values: readonly string[];
  onChange: (next: string[]) => void;
  max?: number | undefined;
  describedBy?: string | undefined;
}

export function TokenPicker({
  label,
  options,
  values,
  onChange,
  max,
  describedBy,
}: TokenPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, close, wrap, trigger);

  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const atCapacity = max !== undefined && values.length >= max;

  function toggle(id: string): void {
    onChange(values.includes(id) ? values.filter((held) => held !== id) : [...values, id]);
  }

  return (
    <div className="token-field" ref={wrap}>
      <div className="token-list">
        {values.map((id) => {
          const known = byId.get(id);

          return (
            <Token
              key={id}
              // Kept on screen under its raw id rather than dropped: a role deleted in Discord is
              // still in the saved config, and a chip nobody can see is one nobody can remove.
              option={known ?? { id, label: id }}
              marked
              unknown={known === undefined}
              onRemove={() => onChange(values.filter((held) => held !== id))}
            />
          );
        })}

        {values.length === 0 ? <span className="token-empty">None yet.</span> : null}

        <button
          type="button"
          ref={trigger}
          className="token-add"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Add ${label}`}
          aria-describedby={describedBy}
          disabled={atCapacity}
          onClick={() => setOpen((was) => !was)}
        >
          <Icon name="plus" />
        </button>
      </div>

      {atCapacity ? <span className="token-note">Limit of {max} reached</span> : null}

      {open ? (
        <Popover
          options={options}
          selected={values}
          multiple
          label={label}
          onPick={toggle}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

export interface TokenInputProps {
  id: string;
  label: string;
  values: readonly (string | number)[];
  onChange: (next: (string | number)[]) => void;
  numeric: boolean;
  max?: number | undefined;
  describedBy?: string | undefined;
}

export function TokenInput({
  id,
  label,
  values,
  onChange,
  numeric,
  max,
  describedBy,
}: TokenInputProps): ReactElement {
  const [draft, setDraft] = useState('');
  const atCapacity = max !== undefined && values.length >= max;

  function add(): void {
    const text = draft.trim();
    if (text === '' || atCapacity) return;

    const entry = numeric ? Number(text) : text;
    if (numeric && !Number.isFinite(entry as number)) return;

    setDraft('');
    if (values.some((held) => String(held) === String(entry))) return;

    onChange([...values, entry]);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="token-field">
      <div className="token-list token-list-typed">
        {values.map((value) => (
          <Token
            key={String(value)}
            option={{ id: String(value), label: String(value) }}
            marked={false}
            unknown={false}
            onRemove={() => onChange(values.filter((held) => held !== value))}
          />
        ))}

        <input
          id={id}
          className="token-entry"
          type="text"
          inputMode={numeric ? 'numeric' : 'text'}
          aria-label={`Add ${label}`}
          aria-describedby={describedBy}
          placeholder={values.length === 0 ? 'Type and press Enter' : ''}
          disabled={atCapacity}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
      </div>

      {atCapacity ? <span className="token-note">Limit of {max} reached</span> : null}
    </div>
  );
}
