import {
  type CSSProperties,
  Fragment,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
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

  // Carried from fetchGuildRoles. Absent where a caller builds a role by hand, and absence claims
  // nothing: a role is offered unless Proton knows it cannot be given out.
  managed?: boolean;
  premiumSubscriber?: boolean;
  assignable?: boolean;
}

const CHANNEL_ICON_FALLBACK: IconName = 'hash';

const CHANNEL_ICONS: Record<number, IconName> = {
  0: 'hash',
  2: 'speaker-high',
  4: 'folder',
  5: 'megaphone',
  11: 'chat-teardrop-text',
  12: 'lock-key',
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

  // Listed, named and refused. A row Proton cannot act on is still shown, because the admin is
  // looking for it and a silently absent role reads as a broken picker.
  blocked?: { why: string } | undefined;
}

export const CHANNEL_NOTE = 'Channels Proton cannot see are not listed.';

export const ROLE_NOTE = 'Roles Proton cannot give out are listed with the reason beside them.';

/**
 * Channels Proton can post a durable message into: text, announcement, and the two thread kinds.
 * Categories cannot hold a message at all, and forum and media channels take posts rather than
 * messages — an unfiltered picker offered all three, the id saved cleanly because the schema only
 * checks it is a snowflake, and the post then failed forever with nothing on the page to show it.
 */
export const POSTABLE_CHANNEL_TYPES = [0, 5, 11, 12] as const;

/**
 * Why a bot cannot grant a role. Discord answers 403 forever for all three, and the picker offered
 * every one of them with nothing said — the same failure POSTABLE_CHANNEL_TYPES was written to end.
 */
export function roleRefusal(role: DiscordRole): { why: string } | undefined {
  if (role.premiumSubscriber === true) return { why: 'the Booster role' };
  if (role.managed === true) return { why: 'managed by an integration' };
  if (role.assignable === false) return { why: 'above Proton’s own role' };

  return undefined;
}

export function roleOptions(roles: readonly DiscordRole[]): PickerOption[] {
  return roles.map((role) => {
    const blocked = roleRefusal(role);

    return {
      id: role.id,
      label: role.name,
      colour: role.color,
      ...(blocked ? { blocked } : {}),
    };
  });
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

const POP_GAP = 6;
const POP_EDGE = 8;

// Below this a list is a slot too small to browse. The overlay stops shrinking and takes the better
// side of the trigger instead, which is what the emoji panel already does.
const POP_MIN_HEIGHT = 160;

export interface PopoverPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  drop: 'up' | 'down';
}

/**
 * Where an overlay goes, generalised from the emoji panel's own placement: the better side of the
 * trigger, shrunk to the room there is, and pulled back inside the viewport rather than hung off
 * its edge. A settings row's control column is most of the way across the window, so a
 * left-anchored overlay of any width runs off the right.
 */
export function placePopover(
  box: DOMRect,
  viewport: { width: number; height: number },
  want: { width: number; height: number },
): PopoverPlacement {
  const below = viewport.height - box.bottom - POP_GAP - POP_EDGE;
  const above = box.top - POP_GAP - POP_EDGE;
  const drop = below >= above ? 'down' : 'up';

  const maxHeight = Math.min(want.height, Math.max(POP_MIN_HEIGHT, Math.max(below, above)));
  const width = Math.max(box.width, Math.min(want.width, viewport.width - POP_EDGE * 2));
  const left = Math.max(POP_EDGE, Math.min(box.left, viewport.width - width - POP_EDGE));

  return {
    top: drop === 'down' ? box.bottom + POP_GAP : Math.max(POP_EDGE, box.top - POP_GAP - maxHeight),
    left,
    width,
    maxHeight,
    drop,
  };
}

export interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  popRef: RefObject<HTMLDivElement | null>;
  className: string;
  want: { width: number; height: number };
  role?: string | undefined;
  id?: string | undefined;
  children: ReactNode;
}

/**
 * The one portalled overlay. Every picker in the product used to be `position: absolute` inside its
 * own row, so a picker in the lower half of a ticket type or a messages template was clipped by
 * `.saved-item { overflow: hidden }` and by `.main`'s own scroll — the option list was simply cut
 * off. Nothing an ancestor does to overflow can reach an overlay parented to the body.
 */
export function Popover({
  anchor,
  popRef,
  className,
  want,
  role,
  id,
  children,
}: PopoverProps): ReactElement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  // The server has no viewport to measure and react-dom's server renderer has no portal, so the
  // overlay exists only once the browser has it — which is also the only place it can be opened.
  useEffect(() => {
    function measure(): void {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;

      setPlacement(
        placePopover(box, { width: window.innerWidth, height: window.innerHeight }, want),
      );
    }

    measure();

    // Fixed to the viewport, so a scroll anywhere — the page, or a card with its own overflow —
    // moves the trigger out from under it. Capture, because a scrolling ancestor does not bubble.
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, { capture: true, passive: true });

    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, { capture: true });
    };
  }, [anchor, want]);

  if (placement === null) return null;

  return createPortal(
    <div
      ref={popRef}
      className={className}
      data-drop={placement.drop}
      role={role}
      id={id}
      style={
        {
          position: 'fixed',
          top: `${placement.top}px`,
          left: `${placement.left}px`,
          width: `${placement.width}px`,
          maxHeight: `${placement.maxHeight}px`,
          '--pop-max-h': `${placement.maxHeight}px`,
        } as CSSProperties
      }
    >
      {children}
    </div>,
    document.body,
  );
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

const PICKER_WANT = { width: 300, height: 420 };

interface PickerPopProps {
  options: readonly PickerOption[];
  selected: readonly string[];
  multiple: boolean;
  label: string;
  anchor: RefObject<HTMLElement | null>;
  popRef: RefObject<HTMLDivElement | null>;
  onPick: (id: string) => void;
  onClose: () => void;

  // Set when the field is already holding as many values as it accepts. The rows stay listed and
  // the chosen ones stay removable; what is refused is adding another.
  full?: boolean | undefined;
}

function PickerPop({
  options,
  selected,
  multiple,
  label,
  anchor,
  popRef,
  onPick,
  onClose,
  full,
}: PickerPopProps): ReactElement {
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
  // channels than the box shows would move aria-activedescendant onto a row the user cannot see,
  // and arrowing down would look like it had stopped working.
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

  function refused(option: PickerOption): boolean {
    if (selected.includes(option.id)) return false;

    return option.blocked !== undefined || full === true;
  }

  function pick(option: PickerOption): void {
    if (refused(option)) return;

    onPick(option.id);
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
      if (current) pick(current);
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
        // A row that does nothing when clicked reads as a broken list, which is the whole
        // complaint. At capacity the unchosen rows say so instead of quietly ignoring the click.
        aria-disabled={refused(option) || undefined}
        data-blocked={refused(option) || undefined}
        data-active={current?.id === option.id || undefined}
        onMouseEnter={() => setActive(matches.indexOf(option))}
        // Down rather than click, so the search box keeps focus and picking a second role needs no
        // second trip to the keyboard.
        onMouseDown={(event) => {
          event.preventDefault();
          pick(option);
        }}
        onKeyDown={() => undefined}
      >
        <Mark option={option} />
        <span className="picker-option-label">{option.label}</span>
        {option.blocked ? <span className="picker-option-why">{option.blocked.why}</span> : null}
        {chosen ? <Icon name="check-circle" weight="fill" className="picker-tick" /> : null}
      </div>
    );
  }

  const note = full
    ? 'This field is full. Remove one to add another.'
    : options.some((option) => option.kind === 'channel')
      ? CHANNEL_NOTE
      : options.some((option) => option.blocked !== undefined)
        ? ROLE_NOTE
        : null;

  return (
    <Popover anchor={anchor} popRef={popRef} className="popover picker-pop" want={PICKER_WANT}>
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
            // biome-ignore lint/suspicious/noArrayIndexKey: positional like the branch above — Discord allows two categories to share a name, and keying on it made them one group
            <div className="picker-group" key={position} role="group" aria-label={group.label}>
              <span className="picker-group-name">{group.label}</span>
              {group.options.map(row)}
            </div>
          ),
        )}

        {matches.length === 0 ? <p className="picker-empty">Nothing matches that.</p> : null}
      </div>

      {note === null ? null : <p className="picker-note">{note}</p>}
    </Popover>
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
  disabled?: boolean | undefined;
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
  disabled,
  describedBy,
}: SinglePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // The overlay is parented to the body, so it is no longer inside the wrapper: the popover is what
  // counts as inside, and the trigger is the second region plus where Escape returns focus.
  useDismiss(open, close, pop, trigger);

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
        disabled={disabled}
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
        <PickerPop
          options={offered}
          selected={value === null ? [] : [value]}
          multiple={false}
          label={label}
          anchor={trigger}
          popRef={pop}
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
    <span className="token" data-unknown={unknown || undefined} title={option.label}>
      {marked ? <Mark option={option} /> : null}
      <span className="token-label">{option.label}</span>
      <button
        type="button"
        className="token-remove"
        aria-label={`Remove ${option.label}`}
        // The popover is parented to the body now, so useDismiss counts everything else as outside
        // and a removal while it was open closed the list the admin was still picking from.
        onPointerDown={(event) => event.stopPropagation()}
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
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, close, pop, trigger);

  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const atCapacity = max !== undefined && values.length >= max;

  // Capacity is checked here and not only on the trigger: the popover stays open across picks, so
  // disabling the + button alone stopped nothing once the list was already showing. Rows kept
  // toggling on past the limit and the save was rejected by the API — "expected array to have <=N
  // items" — naming no chip the admin could remove. Removing stays allowed at capacity.
  function toggle(id: string): void {
    if (values.includes(id)) {
      onChange(values.filter((held) => held !== id));
      return;
    }

    if (atCapacity) return;

    onChange([...values, id]);
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
        <PickerPop
          options={options}
          selected={values}
          multiple
          label={label}
          anchor={trigger}
          popRef={pop}
          onPick={toggle}
          full={atCapacity}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

export type TokenCommit = 'enter' | 'enter-or-comma';

export interface TokenInputProps {
  id: string;
  label: string;
  values: readonly (string | number)[];
  onChange: (next: (string | number)[]) => void;
  numeric: boolean;
  max?: number | undefined;
  describedBy?: string | undefined;

  // 'enter' for anything a comma can appear inside. A regex quantifier — a{2,5} — was split into
  // two chips, neither of them a pattern, with nothing on the page saying so.
  commitOn?: TokenCommit | undefined;
}

export function TokenInput({
  id,
  label,
  values,
  onChange,
  numeric,
  max,
  describedBy,
  commitOn = 'enter-or-comma',
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
    if (event.key === 'Enter' || (event.key === ',' && commitOn === 'enter-or-comma')) {
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
