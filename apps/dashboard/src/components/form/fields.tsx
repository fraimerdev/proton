import type {
  BooleanField,
  ChannelIdField,
  DurationField,
  EnumField,
  FieldDescriptor,
  NumberField,
  StringField,
} from '@proton/core';
import { tryParseDuration } from '@proton/core';
import type { ComponentType, ReactElement } from 'react';

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export interface DiscordRole {
  id: string;
  name: string;
  position: number;
}

export interface FieldProps<D extends FieldDescriptor = FieldDescriptor> {
  descriptor: D;
  value: unknown;
  onChange: (value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
  roles?: readonly DiscordRole[] | undefined;
}

function Label({ descriptor }: { descriptor: FieldDescriptor }): ReactElement {
  return (
    <span className="field-label">
      <span className="field-label-text">{descriptor.label}</span>
      {descriptor.description ? (
        <span className="field-description">{descriptor.description}</span>
      ) : null}
    </span>
  );
}

export function BooleanFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as BooleanField;
  return (
    <label className="field field-boolean" data-path={field.path}>
      <Label descriptor={field} />
      <input
        type="checkbox"
        role="switch"
        aria-checked={value === true}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function StringFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as StringField;
  return (
    <label className="field field-string" data-path={field.path}>
      <Label descriptor={field} />
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        minLength={field.minLength}
        maxLength={field.maxLength}
        required={!field.optional}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function NumberFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as NumberField;
  return (
    <label className="field field-number" data-path={field.path}>
      <Label descriptor={field} />
      <input
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
        min={field.min}
        max={field.max}
        required={!field.optional}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)}
      />
    </label>
  );
}

export function EnumFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as EnumField;
  return (
    <label className="field field-enum" data-path={field.path}>
      <Label descriptor={field} />
      <select
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {field.optional ? <option value="">Not set</option> : null}
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ChannelIdFieldInput({
  descriptor,
  value,
  onChange,
  channels = [],
}: FieldProps): ReactElement {
  const field = descriptor as ChannelIdField;
  const allowed = field.channelTypes
    ? channels.filter((c) => field.channelTypes?.includes(c.type))
    : channels;

  return (
    <label className="field field-channel-id" data-path={field.path}>
      <Label descriptor={field} />
      <select
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{field.optional ? 'No channel' : 'Select a channel'}</option>
        {allowed.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RoleIdFieldInput({
  descriptor,
  value,
  onChange,
  roles = [],
}: FieldProps): ReactElement {
  return (
    <label className="field field-role-id" data-path={descriptor.path}>
      <Label descriptor={descriptor} />
      <select
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{descriptor.optional ? 'No role' : 'Select a role'}</option>
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            @{role.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DurationFieldInput({ descriptor, value, onChange }: FieldProps): ReactElement {
  const field = descriptor as DurationField;
  const text = typeof value === 'string' ? value : '';
  const invalid = text !== '' && tryParseDuration(text) === null;

  return (
    <label className="field field-duration" data-path={field.path}>
      <Label descriptor={field} />
      <span className="field-control">
        <input
          type="text"
          value={text}
          placeholder="30m"
          required={!field.optional}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
        {invalid ? (
          <span className="field-error" role="alert">
            “{text}” is not a duration. Use a number followed by s, m, h, d or w — 30m, 12h, 7d.
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function makeArrayFieldInput(
  resolveElement: (descriptor: FieldDescriptor) => ComponentType<FieldProps>,
) {
  return function ArrayFieldInput({
    descriptor,
    value,
    onChange,
    channels,
    roles,
  }: FieldProps): ReactElement {
    const items = Array.isArray(value) ? value : [];

    const { array: _array, ...element } = descriptor;
    const Element = resolveElement(element as FieldDescriptor);

    const replace = (index: number, next: unknown): void =>
      onChange(items.map((item, i) => (i === index ? next : item)));

    const atCapacity = descriptor.maxItems !== undefined && items.length >= descriptor.maxItems;

    return (
      <div className="field field-array" data-path={descriptor.path}>
        <Label descriptor={descriptor} />
        <div className="field-array-items">
          {items.map((item, index) => (
            <div
              className="field-array-item"
              // biome-ignore lint/suspicious/noArrayIndexKey: values are not unique
              key={`${descriptor.path}-${index}`}
            >
              <Element
                descriptor={
                  { ...element, label: `${descriptor.label} ${index + 1}` } as FieldDescriptor
                }
                value={item}
                onChange={(next) => replace(index, next)}
                channels={channels}
                roles={roles}
              />
              <button
                type="button"
                className="button button-quiet"
                aria-label={`Remove ${descriptor.label} ${index + 1}`}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          ))}
          {items.length === 0 ? <p className="field-empty">None yet.</p> : null}
          <button
            type="button"
            className="button button-quiet"
            disabled={atCapacity}
            onClick={() => onChange([...items, ''])}
          >
            {atCapacity ? `Limit of ${descriptor.maxItems} reached` : `Add ${descriptor.label}`}
          </button>
        </div>
      </div>
    );
  };
}

export function UnsupportedFieldInput({ descriptor }: FieldProps): ReactElement {
  return (
    <div className="field field-unsupported" role="alert" data-path={descriptor.path}>
      Cannot render “{descriptor.label}”: unsupported field type “
      {(descriptor as { kind: string }).kind}”. This is a bug in Proton, not in your configuration.
    </div>
  );
}
