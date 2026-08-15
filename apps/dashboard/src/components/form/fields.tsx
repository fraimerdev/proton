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

/**
 * A spinner carrying the schema's own bounds.
 *
 * An emptied box becomes `undefined` rather than `0`: zero is a legitimate value
 * for several config fields (`defaultBanDeleteDays`), so silently substituting it
 * for "I cleared this" would save a setting the admin never chose.
 */
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
        {/* Only offered when the schema allows absence — otherwise an admin
            could clear a required choice and only find out on save. */}
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

/**
 * Role picker.
 *
 * Roles arrive highest-first (see `fetchGuildRoles`) because that is the order
 * Discord shows them in and the order that matters for hierarchy — a staff role
 * is near the top, and an alphabetical list would bury it.
 */
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

/**
 * Duration text box that validates as you type.
 *
 * `tryParseDuration` is the runtime's own parser, so the message here cannot
 * drift from what the module will actually accept on save. Showing it inline is
 * the difference between "1 hour" being rejected at the field and being rejected
 * by a save that looked like it worked.
 */
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

/**
 * A flat array of a scalar kind, rendered as one control per element.
 *
 * The element control is whatever the registry resolves for the kind, so an
 * array of channel ids gets channel pickers and an array of role ids gets role
 * pickers — adding an array-of-X costs nothing once X exists.
 *
 * `resolveElement` is injected rather than imported to keep this module free of
 * a cycle with the registry that lists it.
 */
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
    // The element descriptor is the same kind without `array`, so the scalar
    // control does not think it is rendering the whole list.
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
              // Index keys: the values are not unique (two empty rows are
              // legitimate mid-edit) and the list is reordered only by the
              // buttons below, which rebuild it wholesale.
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

/**
 * Shown when a descriptor arrives with a kind this build cannot render.
 *
 * Visible and specific on purpose. A silent fallback — a blank div, or quietly
 * skipping the field — would let a guild admin save a config with a field they
 * never saw, which is worse than an obvious error.
 */
export function UnsupportedFieldInput({ descriptor }: FieldProps): ReactElement {
  return (
    <div className="field field-unsupported" role="alert" data-path={descriptor.path}>
      Cannot render “{descriptor.label}”: unsupported field type “
      {(descriptor as { kind: string }).kind}”. This is a bug in Proton, not in your configuration.
    </div>
  );
}
