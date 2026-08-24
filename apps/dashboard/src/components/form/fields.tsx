import type {
  BooleanField,
  ChannelIdField,
  ColourField,
  DurationField,
  EnumField,
  FieldDescriptor,
  NumberField,
  StringField,
} from '@proton/core';
import { tryParseDuration } from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { Icon } from '../shell/icon.tsx';
import type { DiscordChannel, DiscordRole } from './picker.tsx';
import {
  channelOptions,
  enumOptions,
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
  children,
}: {
  descriptor: FieldDescriptor;
  param: FieldSlot | undefined;
  controlId?: string | undefined;
  describedBy: string;
  className: string;
  hidden?: boolean | undefined;
  children: ReactNode;
}): ReactElement {
  if (!param) {
    return (
      <div className={`field ${className}`} data-path={descriptor.path} hidden={hidden}>
        <Head descriptor={descriptor} controlId={controlId} describedBy={describedBy} />
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

function Head({
  descriptor,
  controlId,
  describedBy,
}: {
  descriptor: FieldDescriptor;
  controlId?: string | undefined;
  describedBy: string;
}): ReactElement {
  return (
    <span className="field-head">
      {controlId === undefined ? (
        <span className="field-label">{descriptor.label}</span>
      ) : (
        <label className="field-label" htmlFor={controlId}>
          {descriptor.label}
        </label>
      )}
      {descriptor.description ? (
        <span className="field-info">
          <button
            type="button"
            className="field-info-button"
            aria-label={`What “${descriptor.label}” does`}
            aria-describedby={describedBy}
          >
            <Icon name="info" weight="fill" />
          </button>
          <span className="field-tooltip" role="tooltip" id={describedBy}>
            {descriptor.description}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function describedBy(descriptor: FieldDescriptor, id: string): string | undefined {
  return descriptor.description ? id : undefined;
}

export function BooleanFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
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

export function StringFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
}: FieldProps): ReactElement {
  const field = descriptor as StringField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-string"
      hidden={hidden}
    >
      <input
        id={controlId}
        type="text"
        value={typeof value === 'string' ? value : ''}
        minLength={field.minLength}
        maxLength={field.maxLength}
        required={!field.optional}
        aria-describedby={describedBy(field, id)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function NumberFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
}: FieldProps): ReactElement {
  const field = descriptor as NumberField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-number"
      hidden={hidden}
    >
      <input
        id={controlId}
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
        min={field.min}
        max={field.max}
        required={!field.optional}
        aria-describedby={describedBy(field, id)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)}
      />
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
}: FieldProps): ReactElement {
  const field = descriptor as ColourField;
  const id = useId();
  const controlId = `${id}-control`;
  const hex = hexOf(value);

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-colour"
      hidden={hidden}
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
          value={hex}
          spellCheck={false}
          aria-label={`${field.label} hex value`}
          onChange={(e) => {
            const typed = e.target.value.trim().replace(/^#/, '');
            if (/^[0-9a-fA-F]{6}$/.test(typed)) onChange(Number.parseInt(typed, 16));
          }}
        />
      </span>
    </Shell>
  );
}

export function EnumFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
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
            {field.optionLabels?.[option] ?? option}
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
}: FieldProps): ReactElement {
  const field = descriptor as ChannelIdField;
  const id = useId();
  const controlId = `${id}-control`;

  // A field carrying a default is never required, and clearing it means going back to that default
  // rather than to null — which is not a value its schema accepts. Serverlog's per-category
  // channels default to '' meaning "inherit", and without this they could be set but never unset.
  const fallback = typeof field.defaultValue === 'string' ? field.defaultValue : null;
  const clearable = field.optional || fallback !== null;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-channel-id"
      hidden={hidden}
    >
      <span className="field-control">
        <SinglePicker
          id={controlId}
          label={param?.name ?? field.label}
          options={channelOptions(channels, field.channelTypes)}
          value={typeof value === 'string' ? value : null}
          onChange={(next) => onChange(next ?? fallback ?? undefined)}
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
}: FieldProps): ReactElement {
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <Shell
      descriptor={descriptor}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-role-id"
      hidden={hidden}
    >
      <span className="field-control">
        <SinglePicker
          id={controlId}
          label={descriptor.label}
          options={roleOptions(roles)}
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
          emptyLabel={descriptor.optional ? 'No role' : 'Select a role'}
          clearable={descriptor.optional}
          describedBy={describedBy(descriptor, id)}
        />
      </span>
    </Shell>
  );
}

export function DurationFieldInput({
  descriptor,
  value,
  onChange,
  param,
  hidden,
}: FieldProps): ReactElement {
  const field = descriptor as DurationField;
  const id = useId();
  const controlId = `${id}-control`;
  const errorId = `${id}-error`;

  const text = typeof value === 'string' ? value : '';
  const invalid = text !== '' && tryParseDuration(text) === null;

  return (
    <Shell
      descriptor={field}
      param={param}
      controlId={controlId}
      describedBy={id}
      className="field-duration"
      hidden={hidden}
    >
      <span className="field-control">
        <input
          id={controlId}
          type="text"
          value={text}
          placeholder="30m"
          required={!field.optional}
          aria-invalid={invalid}
          aria-describedby={
            [describedBy(field, id), invalid ? errorId : undefined].filter(Boolean).join(' ') ||
            undefined
          }
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
        {invalid ? (
          <span className="field-error" id={errorId} role="alert">
            “{text}” is not a duration. Use a number followed by s, m, h, d or w — 30m, 12h, 7d.
          </span>
        ) : null}
      </span>
    </Shell>
  );
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
          ? enumOptions(descriptor.options)
          : null;

  return (
    <div className="field field-array field-stacked" data-path={descriptor.path} hidden={hidden}>
      <Head descriptor={descriptor} {...(options === null ? { controlId } : {})} describedBy={id} />
      {options === null ? (
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
