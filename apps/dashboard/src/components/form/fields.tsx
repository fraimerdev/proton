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
import type { ReactElement } from 'react';
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
}

function Head({
  descriptor,
  controlId,
  describedBy,
}: {
  descriptor: FieldDescriptor;
  controlId?: string;
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

export function BooleanFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as BooleanField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="field field-boolean" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
      <input
        id={controlId}
        type="checkbox"
        role="switch"
        aria-checked={value === true}
        aria-describedby={describedBy(field, id)}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

export function StringFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as StringField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="field field-string" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
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
    </div>
  );
}

export function NumberFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as NumberField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="field field-number" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
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
    </div>
  );
}

function hexOf(value: unknown): string {
  return `#${(typeof value === 'number' ? value : 0).toString(16).padStart(6, '0')}`;
}

export function ColourFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as ColourField;
  const id = useId();
  const controlId = `${id}-control`;
  const hex = hexOf(value);

  return (
    <div className="field field-colour" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
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
    </div>
  );
}

export function EnumFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as EnumField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="field field-enum" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
      <select
        id={controlId}
        value={typeof value === 'string' ? value : ''}
        aria-describedby={describedBy(field, id)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {field.optional ? <option value="">Not set</option> : null}
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ChannelIdFieldInput({
  descriptor,
  value,
  onChange,
  channels = [],
}: FieldProps): ReactElement {
  const field = descriptor as ChannelIdField;
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="field field-channel-id" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
      <span className="field-control">
        <SinglePicker
          id={controlId}
          label={field.label}
          options={channelOptions(channels, field.channelTypes)}
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
          emptyLabel={field.optional ? 'No channel' : 'Select a channel'}
          clearable={field.optional}
          describedBy={describedBy(field, id)}
        />
      </span>
    </div>
  );
}

export function RoleIdFieldInput({
  descriptor,
  value,
  onChange,
  roles = [],
}: FieldProps): ReactElement {
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="field field-role-id" data-path={descriptor.path}>
      <Head descriptor={descriptor} controlId={controlId} describedBy={id} />
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
    </div>
  );
}

export function DurationFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as DurationField;
  const id = useId();
  const controlId = `${id}-control`;
  const errorId = `${id}-error`;

  const text = typeof value === 'string' ? value : '';
  const invalid = text !== '' && tryParseDuration(text) === null;

  return (
    <div className="field field-duration" data-path={field.path}>
      <Head descriptor={field} controlId={controlId} describedBy={id} />
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
    </div>
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
    <div className="field field-array field-stacked" data-path={descriptor.path}>
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

export function UnsupportedFieldInput({ descriptor }: FieldProps): ReactElement {
  return (
    <div className="field field-unsupported" role="alert" data-path={descriptor.path}>
      Cannot render “{descriptor.label}”: unsupported field type “
      {(descriptor as { kind: string }).kind}”. This is a bug in Proton, not in your configuration.
    </div>
  );
}
