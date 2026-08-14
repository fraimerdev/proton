import type { BooleanField, ChannelIdField, FieldDescriptor, StringField } from '@proton/core';
import type { ReactElement } from 'react';

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export interface FieldProps<D extends FieldDescriptor = FieldDescriptor> {
  descriptor: D;
  value: unknown;
  onChange: (value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
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
