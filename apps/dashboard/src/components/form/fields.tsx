import type {
  BooleanField,
  ChannelIdField,
  ColourField,
  DurationField,
  EnumField,
  FieldDescriptor,
  NumberField,
  RoleIdField,
  StringField,
} from '@proton/core';
import { tryParseDuration } from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useId, useRef, useState } from 'react';
import { optionLabel } from '../../lib/enum-labels.ts';
import { EmojiInput } from '../emoji/picker.tsx';
import { useDismiss } from '../shell/dismiss.ts';
import { Icon } from '../shell/icon.tsx';
import { PatternList, patternSyntaxFor } from './pattern-list.tsx';
import type { DiscordChannel, DiscordRole } from './picker.tsx';
import {
  channelOptions,
  enumOptions,
  Popover,
  roleOptions,
  SinglePicker,
  TokenInput,
  TokenPicker,
} from './picker.tsx';

export type { DiscordChannel, DiscordRole } from './picker.tsx';
export { CHANNEL_ICON_NAMES, channelIcon, roleStyle } from './picker.tsx';

export interface FieldProps<D extends FieldDescriptor = FieldDescriptor> {
  descriptor: D;
  value: unknown;
  onChange: (value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
  roles?: readonly DiscordRole[] | undefined;

  // Set when the field is one cell of a rule row or a matrix rather than a row of its own.
  param?: FieldSlot | undefined;

  // On the field's own root, never on a wrapper: the form's only row separator is `.field + .field`,
  // and an element in between stops the adjacent sibling matching at all.
  hidden?: boolean | undefined;

  // The rare long caveat, behind the ⓘ. `description` is printed on the row instead: it is the one
  // sentence that stops somebody pinging the whole server, and it was hidden behind a hover.
  detail?: string | undefined;

  // A duration's own ceiling, in seconds, so the control can refuse 29 days on a Discord timeout
  // rather than accepting it and explaining itself afterwards.
  bounds?: DurationBounds | undefined;
}

export interface DurationBounds {
  minSeconds?: number | undefined;
  maxSeconds?: number | undefined;
}

export interface FieldSlot {
  label: string | undefined;

  // The accessible name, where every control in a column shares one label and the row it sits on
  // is what tells them apart.
  name?: string | undefined;

  emptyLabel?: string | undefined;
}

function Shell({
  descriptor,
  param,
  controlId,
  describedBy,
  className,
  hidden,
  detail,
  children,
}: {
  descriptor: FieldDescriptor;
  param: FieldSlot | undefined;
  controlId?: string | undefined;
  describedBy: string;
  className: string;
  hidden?: boolean | undefined;
  detail?: string | undefined;
  children: ReactNode;
}): ReactElement {
  if (!param) {
    return (
      <div className={`field ${className}`} data-path={descriptor.path} hidden={hidden}>
        <Head
          label={descriptor.label}
          description={descriptor.description}
          controlId={controlId}
          describedBy={describedBy}
          detail={detail}
        />
        {children}
      </div>
    );
  }

  return (
    <span className={`rule-param ${className}`} data-path={descriptor.path} hidden={hidden}>
      {/* Named even when the rule's own label has already said it: two controls whose only
          difference is their type are two identical names in the accessibility tree. */}
      <label
        className={param.label === undefined ? 'sr-only' : 'rule-param-label'}
        htmlFor={controlId}
      >
        {param.label ?? param.name ?? descriptor.label}
      </label>
      {children}
    </span>
  );
}

const TOOLTIP_WANT = { width: 320, height: 240 };

/**
 * The ⓘ, for the caveat that is too long to sit on the row. It opens on a press rather than on
 * hover: hover-revealed content has to survive the pointer travelling into it, and this one is
 * parented to the body so that no card's overflow can clip it.
 */
function FieldDetail({ label, text }: { label: string; text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, close, pop, trigger);

  return (
    <span className="field-info">
      <button
        type="button"
        ref={trigger}
        className="field-info-button"
        aria-label={`What “${label}” does`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="info" weight="fill" />
      </button>

      {open ? (
        <Popover
          anchor={trigger}
          popRef={pop}
          className="popover field-tooltip"
          want={TOOLTIP_WANT}
          role="tooltip"
          id={tipId}
        >
          {text}
        </Popover>
      ) : null}
    </span>
  );
}

function Head({
  label,
  description,
  controlId,
  describedBy,
  detail,
}: {
  label: string;
  description?: string | undefined;
  controlId?: string | undefined;
  describedBy: string;
  detail?: string | undefined;
}): ReactElement {
  return (
    <span className="field-head">
      <span className="field-head-line">
        {controlId === undefined ? (
          <span className="field-label">{label}</span>
        ) : (
          <label className="field-label" htmlFor={controlId}>
            {label}
          </label>
        )}
        {detail ? <FieldDetail label={label} text={detail} /> : null}
      </span>

      {/* On the row, not behind a hover. This is the sentence that stops somebody pinging forty
          thousand people, and it is also what aria-describedby on the control points at. */}
      {description ? (
        <span className="field-description" id={describedBy}>
          {description}
        </span>
      ) : null}
    </span>
  );
}

function describedBy(descriptor: FieldDescriptor, id: string): string | undefined {
  return descriptor.description ? id : undefined;
}

/**
 * An emptied optional text box means "unset", not the empty string. Those fields are
 * `z.string().min(1)…optional()`, which rejects '' — so clearing Branding's "Server nickname",
 * whose own help text says to leave it empty to use Proton's own name, wrote a value its schema
 * refuses and made the whole module unsavable.
 *
 * A required box keeps the '' instead of falling back to its default. Unlike a picker, whose clear
 * is one discrete act, '' here is a keystroke on the way somewhere: substituting the default would
 * refill the box under the cursor, and backspacing Ping's "Pong!" looped forever.
 */
export function emptied(field: StringField, next: string): string | undefined {
  if (next !== '') return next;

  return field.optional ? undefined : '';
}

/**
 * SinglePicker reports `null` for "cleared", and no config schema in the product accepts null —
 * every channel and role field is `snowflakeSchema.optional()`, which is `string | undefined`. So
 * a cleared field has to be written as undefined or the whole module's save is rejected with
 * "expected string, received null".
 *
 * A field carrying a default clears back to that default instead: serverlog's per-category channels
 * default to '' meaning "inherit", and without this they could be set but never unset.
 *
 * Shared by both id pickers because they diverged once already — the role one passed the raw null
 * straight through, and unsetting any role broke saving for that module entirely.
 */
export function clearingOf(field: ChannelIdField | RoleIdField): {
  clearable: boolean;
  cleared: (next: string | null) => string | undefined;
} {
  const fallback = typeof field.defaultValue === 'string' ? field.defaultValue : null;

  return {
    clearable: field.optional || fallback !== null,
    cleared: (next) => next ?? fallback ?? undefined,
  };
}

export function BooleanFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as BooleanField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-boolean"
      hidden={hidden}
      detail={detail}
    >
      <input
        id={controlId}
        type="checkbox"
        role="switch"
        aria-checked={value === true}
        aria-describedby={describedBy(field, id)}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    </Shell>
  );
}

export interface BooleanGroupToggle {
  path: string;
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}

export interface BooleanGroupProps {
  label: string;
  description?: string | undefined;
  detail?: string | undefined;
  toggles: readonly BooleanGroupToggle[];
  hidden?: boolean | undefined;
}

/**
 * One decision with several parts, on one row. Three related booleans — leveling's "what the card
 * shows", starboard's scope, honeypot's notice — were three 57px rows carrying a 23px switch each,
 * and reading them as three separate settings is the mistake the layout was teaching.
 */
export function BooleanGroupFieldInput({
  label,
  description,
  detail,
  toggles,
  hidden,
}: BooleanGroupProps): ReactElement {
  const id = useId();

  return (
    <div className="field field-bool-group" hidden={hidden}>
      <Head label={label} description={description} describedBy={id} detail={detail} />

      <fieldset className="bool-group">
        {/* The row's own label is the group's name, and a legend is how a checkbox group carries
            one — but printing it twice is what the sr-only is for. */}
        <legend className="sr-only">{label}</legend>

        {toggles.map((toggle) => (
          <label className="bool-group-item" key={toggle.path} data-path={toggle.path}>
            <input
              type="checkbox"
              checked={toggle.value}
              aria-describedby={description ? id : undefined}
              onChange={(e) => toggle.onChange(e.target.checked)}
            />
            <span>{toggle.label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

export function StringFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as StringField;
  const id = useId();
  const controlId = `${id}-control`;

  const held = typeof value === 'string' ? value : '';

  const control = (
    <input
      id={controlId}
      type="text"
      value={held}
      minLength={field.minLength}
      maxLength={field.maxLength}
      required={!field.optional}
      aria-describedby={describedBy(field, id)}
      onChange={(e) => onChange(emptied(field, e.target.value))}
    />
  );

  // Wrapped only when there is a counter to carry: .field is a two-column grid, so an unconditional
  // wrapper would move every string field in the product into a box it did not have before.
  const counted = field.maxLength !== undefined && param === undefined;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-string"
      hidden={hidden}
      detail={detail}
    >
      {counted ? (
        <span className="field-counted">
          {control}
          {/* Counted in UTF-16 units, matching both maxLength above and Zod's .max(), because
              Discord documents "32 characters" without saying which unit it counts — and the
              stricter reading is the one that never earns a 400. */}
          <span className="field-counter" aria-hidden="true">
            {held.length}/{field.maxLength}
          </span>
        </span>
      ) : (
        control
      )}
    </Shell>
  );
}

export function NumberFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as NumberField;
  const id = useId();
  const controlId = `${id}-control`;
  const errorId = `${id}-error`;

  const empty = value === undefined && !field.optional;
  const outOfRange =
    typeof value === 'number' &&
    ((field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max));

  const invalid = empty || outOfRange;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-number"
      hidden={hidden}
      detail={detail}
    >
      <span className="field-control">
        <input
          id={controlId}
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
          min={field.min}
          max={field.max}
          required={!field.optional}
          aria-invalid={invalid}
          aria-describedby={
            [describedBy(field, id), invalid ? errorId : undefined].filter(Boolean).join(' ') ||
            undefined
          }
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)}
        />
        {invalid ? (
          <span className="field-error" id={errorId} role="alert">
            {empty
              ? 'This needs a number. Left empty it saves as whatever the module defaults to.'
              : `Use a number between ${field.min ?? 0} and ${field.max ?? '∞'}.`}
          </span>
        ) : null}
      </span>
    </Shell>
  );
}

function hexOf(value: unknown): string {
  return `#${(typeof value === 'number' ? value : 0).toString(16).padStart(6, '0')}`;
}

export function ColourFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as ColourField;
  const id = useId();
  const controlId = `${id}-control`;
  const errorId = `${id}-error`;
  const hex = hexOf(value);

  // Held, not derived: a controlled hex field reverts every keystroke before the sixth, so the box
  // could only ever be pasted into. The builder's own colour input already works this way.
  const [seen, setSeen] = useState(hex);
  const [draft, setDraft] = useState(hex);

  if (seen !== hex) {
    setSeen(hex);
    setDraft(hex);
  }

  const wrong = !/^#[0-9a-fA-F]{6}$/.test(draft.trim());

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-colour"
      hidden={hidden}
      detail={detail}
    >
      <span className="colour-input">
        <input
          id={controlId}
          type="color"
          value={hex}
          aria-describedby={describedBy(field, id)}
          onChange={(e) => onChange(Number.parseInt(e.target.value.slice(1), 16))}
        />
        {/* Typed as well as picked: a brand colour arrives as a hex string from a style guide, and
            hunting for it in a colour wheel is how you end up one shade off. */}
        <input
          className="colour-hex"
          type="text"
          value={draft}
          spellCheck={false}
          aria-label={`${field.label} hex value`}
          aria-invalid={wrong || undefined}
          aria-describedby={wrong ? errorId : undefined}
          // Blur resyncs, or a half-typed draft outlives the field it was typed into.
          onBlur={() => setDraft(hex)}
          onChange={(e) => {
            setDraft(e.target.value);

            const typed = e.target.value.trim().replace(/^#/, '');
            if (/^[0-9a-fA-F]{6}$/.test(typed)) onChange(Number.parseInt(typed, 16));
          }}
        />
        {/* Inside .colour-input, not beside it: .field is a two-column grid, so a third child
            landed in the label column of the row below. */}
        {wrong ? (
          <span className="field-error" id={errorId} role="alert">
            A colour is six hex digits, like #5865F2. The swatch keeps its value until this reads as
            one.
          </span>
        ) : null}
      </span>
    </Shell>
  );
}

/**
 * An emoji is a string in the config, and used to be a string in the form too — a box asking an
 * admin to type a unicode character their keyboard cannot produce, or paste `<:name:123…>` out of
 * a Discord message. The stored shape is unchanged; only the way one is chosen is.
 */
export function EmojiFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const id = useId();

  return (
    <Shell
      descriptor={descriptor}
      param={param}
      describedBy={id}
      className="field-emoji"
      hidden={hidden}
      detail={detail}
    >
      <EmojiInput
        value={typeof value === 'string' ? value : ''}
        clearable={descriptor.optional}
        name={param?.name ?? descriptor.label}
        onChange={(next) => onChange(descriptor.optional && next === '' ? undefined : next)}
      />
    </Shell>
  );
}

export function EnumFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as EnumField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-enum"
      hidden={hidden}
      detail={detail}
    >
      <select
        id={controlId}
        value={typeof value === 'string' ? value : ''}
        aria-describedby={describedBy(field, id)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {field.optional ? <option value="">Not set</option> : null}
        {field.options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option, field.optionLabels)}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function ChannelIdFieldInput({
  descriptor,
  value,
  onChange,
  channels = [],
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as ChannelIdField;
  const id = useId();
  const controlId = `${id}-control`;

  const { clearable, cleared } = clearingOf(field);

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-channel-id"
      hidden={hidden}
      detail={detail}
    >
      <span className="field-control">
        <SinglePicker
          id={controlId}
          label={param?.name ?? field.label}
          options={channelOptions(channels, field.channelTypes)}
          value={typeof value === 'string' ? value : null}
          onChange={(next) => onChange(cleared(next))}
          emptyLabel={param?.emptyLabel ?? (clearable ? 'No channel' : 'Select a channel')}
          clearable={clearable}
          describedBy={describedBy(field, id)}
        />
      </span>
    </Shell>
  );
}

export function RoleIdFieldInput({
  descriptor,
  value,
  onChange,
  roles = [],
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as RoleIdField;
  const id = useId();
  const controlId = `${id}-control`;

  const { clearable, cleared } = clearingOf(field);

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-role-id"
      hidden={hidden}
      detail={detail}
    >
      <span className="field-control">
        <SinglePicker
          id={controlId}
          label={param?.name ?? field.label}
          options={roleOptions(roles)}
          value={typeof value === 'string' ? value : null}
          onChange={(next) => onChange(cleared(next))}
          emptyLabel={param?.emptyLabel ?? (clearable ? 'No role' : 'Select a role')}
          clearable={clearable}
          describedBy={describedBy(field, id)}
        />
      </span>
    </Shell>
  );
}

export const DURATION_UNITS = [
  { unit: 's', label: 'seconds', per: 1 },
  { unit: 'm', label: 'minutes', per: 60 },
  { unit: 'h', label: 'hours', per: 3_600 },
  { unit: 'd', label: 'days', per: 86_400 },
  { unit: 'w', label: 'weeks', per: 604_800 },
] as const;

const DURATION_PATTERN = /^(\d+)\s*([smhdw])$/i;

function perSecondsOf(unit: string): number {
  return DURATION_UNITS.find((part) => part.unit === unit)?.per ?? 1;
}

/**
 * A duration is stored as one number and one unit — `30m`, `7d` — so the control can be exactly
 * that, and the grammar stops being something to guess from a placeholder and learn from an error.
 * What was here was `<input type="text">`, which accepted "banana" until the save bar caught it.
 */
export function DurationFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
  bounds,
}: FieldProps): ReactElement {
  const field = descriptor as DurationField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-duration"
      hidden={hidden}
      detail={detail}
    >
      <span className="field-control">
        <DurationControl
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          bounds={bounds}
          label={param?.name ?? field.label}
          controlId={controlId}
          required={!field.optional}
          describedBy={describedBy(field, id)}
        />
      </span>
    </Shell>
  );
}

// Amount and unit, its own bounds, its own named error. Split out of the settings field so anything
// asking for a duration gets the control rather than a text box that only knew it was wrong.
export function DurationControl({
  value,
  onChange,
  bounds,
  label,
  controlId,
  required = false,
  describedBy: described,
}: {
  value: string;
  onChange: (next: string | undefined) => void;
  bounds?: DurationBounds | undefined;
  label: string;
  controlId?: string | undefined;
  required?: boolean | undefined;
  describedBy?: string | undefined;
}): ReactElement {
  const id = useId();
  const errorId = `${id}-error`;

  const text = value;
  const parsed = DURATION_PATTERN.exec(text.trim());

  // Held, both of them. The stored string is rebuilt on every keystroke, so "3" rebuilt as "3m"
  // would refill the box under the cursor, and an emptied box has no unit left to read back — the
  // select jumped from days to minutes mid-edit. A value arriving from outside still wins, so a
  // reset puts both back.
  const [draft, setDraft] = useState<string | null>(null);
  const [lastUnit, setLastUnit] = useState<string | null>(null);

  const unit = (parsed?.[2] ?? lastUnit ?? 'm').toLowerCase();
  const amount = parsed?.[1] ?? '';
  const shown = draft ?? amount;

  const unreadable = text !== '' && tryParseDuration(text) === null;

  const per = perSecondsOf(unit);
  const ceiling = bounds?.maxSeconds === undefined ? null : Math.floor(bounds.maxSeconds / per);
  const floor = bounds?.minSeconds === undefined ? null : Math.ceil(bounds.minSeconds / per);

  const over = ceiling !== null && shown !== '' && Number(shown) > ceiling;
  const under = floor !== null && shown !== '' && Number(shown) < floor;
  const invalid = unreadable || over || under;

  function write(next: string, nextUnit: string): void {
    setLastUnit(nextUnit);
    onChange(next === '' ? undefined : `${next}${nextUnit}`);
  }

  function typed(raw: string): void {
    const digits = raw.replace(/\D/g, '');

    setDraft(digits);
    write(digits, unit);
  }

  /**
   * The paste path the text box used to be. A number input discards "7d" before any handler sees
   * it, so the clipboard is read here instead — an admin copying a value out of a help page or
   * another server's settings pastes a whole duration, not a bare number.
   */
  function pasted(clipboard: string): boolean {
    const whole = DURATION_PATTERN.exec(clipboard.trim());
    if (!whole?.[1] || !whole[2]) return false;

    setDraft(whole[1]);
    write(whole[1], whole[2].toLowerCase());

    return true;
  }

  return (
    <>
      <span className="duration-field">
        <input
          id={controlId}
          className="duration-amount"
          type="number"
          value={shown}
          min={floor ?? 0}
          max={ceiling ?? undefined}
          step={1}
          required={required}
          aria-invalid={invalid}
          aria-describedby={
            [described, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined
          }
          onBlur={() => {
            setDraft(null);
            if (ceiling !== null && shown !== '' && Number(shown) > ceiling) {
              write(String(ceiling), unit);
            }
          }}
          onChange={(e) => typed(e.target.value)}
          onPaste={(e) => {
            if (pasted(e.clipboardData.getData('text'))) e.preventDefault();
          }}
        />
        <select
          className="duration-unit"
          value={unit}
          aria-label={`${label}, unit`}
          onChange={(e) => {
            setDraft(null);
            write(shown, e.target.value);
          }}
        >
          {DURATION_UNITS.map((part) => (
            <option key={part.unit} value={part.unit}>
              {part.label}
            </option>
          ))}
        </select>
      </span>

      {invalid ? (
        <span className="field-error" id={errorId} role="alert">
          {unreadable
            ? `“${text}” is not a duration. Use a number followed by s, m, h, d or w — 30m, 12h, 7d.`
            : over
              ? `This setting allows at most ${ceiling} ${unitLabel(unit)}.`
              : `This setting needs at least ${floor} ${unitLabel(unit)}.`}
        </span>
      ) : null}
    </>
  );
}

function unitLabel(unit: string): string {
  return DURATION_UNITS.find((part) => part.unit === unit)?.label ?? unit;
}

export const TOKEN_KINDS: readonly FieldDescriptor['kind'][] = [
  'string',
  'number',
  'duration',
  'enum',
  'channel-id',
  'role-id',
];

// One row of chips rather than one control per entry: a guild that exempts nine roles was nine
// full-width selects tall, and every one of them re-listed every role in the server.
export function ArrayFieldInput({
  descriptor,
  value,
  onChange,
  channels = [],
  roles = [],
  hidden,
  detail,
}: FieldProps): ReactElement {
  const id = useId();
  const controlId = `${id}-control`;
  const items = Array.isArray(value) ? (value as (string | number)[]) : [];

  const options =
    descriptor.kind === 'role-id'
      ? roleOptions(roles)
      : descriptor.kind === 'channel-id'
        ? channelOptions(channels, descriptor.channelTypes)
        : descriptor.kind === 'enum'
          ? enumOptions(descriptor.options, descriptor.optionLabels)
          : null;

  // Patterns and phrases are not chips. A chip commits on a comma, and a comma is a quantifier's
  // own punctuation: `a{2,5}` came out as `a{2` and `5}`, neither of them something Discord runs.
  const syntax = options === null ? patternSyntaxFor(descriptor.path) : null;

  return (
    <div className="field field-array field-stacked" data-path={descriptor.path} hidden={hidden}>
      <Head
        label={descriptor.label}
        description={descriptor.description}
        {...(options === null ? { controlId } : {})}
        describedBy={id}
        detail={detail}
      />
      {syntax !== null ? (
        <PatternList
          id={controlId}
          label={descriptor.label}
          values={items.map(String)}
          onChange={onChange}
          syntax={syntax}
          max={descriptor.maxItems}
          {...(descriptor.kind === 'string' && descriptor.maxLength !== undefined
            ? { maxLength: descriptor.maxLength }
            : {})}
          describedBy={describedBy(descriptor, id)}
        />
      ) : options === null ? (
        <TokenInput
          id={controlId}
          label={descriptor.label}
          values={items}
          onChange={onChange}
          numeric={descriptor.kind === 'number'}
          max={descriptor.maxItems}
          describedBy={describedBy(descriptor, id)}
        />
      ) : (
        <TokenPicker
          label={descriptor.label}
          options={options}
          values={items.map(String)}
          onChange={onChange}
          max={descriptor.maxItems}
          describedBy={describedBy(descriptor, id)}
        />
      )}
    </div>
  );
}

export function UnsupportedFieldInput({ descriptor, hidden }: FieldProps): ReactElement {
  return (
    <div
      className="field field-unsupported"
      role="alert"
      data-path={descriptor.path}
      hidden={hidden}
    >
      Cannot render “{descriptor.label}”: unsupported field type “
      {(descriptor as { kind: string }).kind}”. This is a bug in Proton, not in your configuration.
    </div>
  );
}

const SECONDS_PARTS = [
  { key: 'days', label: 'days', per: 86_400 },
  { key: 'hours', label: 'hrs', per: 3_600 },
  { key: 'minutes', label: 'min', per: 60 },
  { key: 'seconds', label: 'sec', per: 1 },
] as const;

function splitSeconds(total: number): Record<string, number> {
  let left = Math.max(0, Math.trunc(total));

  const parts: Record<string, number> = {};
  for (const part of SECONDS_PARTS) {
    parts[part.key] = Math.floor(left / part.per);
    left -= (parts[part.key] as number) * part.per;
  }

  return parts;
}

export function SecondsFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
  detail,
}: FieldProps): ReactElement {
  const field = descriptor as NumberField;
  const id = useId();
  const errorId = `${id}-error`;

  const total = typeof value === 'number' ? value : 0;
  const parts = splitSeconds(total);

  const max = field.max ?? Number.MAX_SAFE_INTEGER;
  const outOfRange = total > max || total < (field.min ?? 0);

  const set = (key: string, next: number): void => {
    const rebuilt = SECONDS_PARTS.reduce(
      (sum, part) => sum + (part.key === key ? next : (parts[part.key] as number)) * part.per,
      0,
    );

    onChange(Math.min(max, Math.max(field.min ?? 0, rebuilt)));
  };

  return (
    <Shell
      descriptor={field}
      param={param}
      describedBy={id}
      className="field-seconds"
      hidden={hidden}
      detail={detail}
    >
      <span className="field-control">
        {/* One grouped control rather than four labelled rows: the spinners are one setting, and
            each carries the field's name so it is not announced as a bare number. */}
        <fieldset className="seconds">
          <legend className="sr-only">{field.label}</legend>
          {SECONDS_PARTS.map((part) => (
            <span className="seconds-part" key={part.key}>
              <input
                type="number"
                min={0}
                aria-label={`${field.label}, ${part.label}`}
                aria-invalid={outOfRange}
                value={String(parts[part.key] ?? 0)}
                onChange={(e) => set(part.key, e.target.value === '' ? 0 : e.target.valueAsNumber)}
              />
              <span className="seconds-unit">{part.label}</span>
            </span>
          ))}
        </fieldset>

        {outOfRange ? (
          <span className="field-error" id={errorId} role="alert">
            That comes to {total} seconds, and this setting allows at most {max}.
          </span>
        ) : null}
      </span>
    </Shell>
  );
}
