import type { FieldDescriptor } from '@proton/core';
import type { ReactElement } from 'react';
import type { DiscordChannel, DiscordRole } from './fields.tsx';
import { resolveFieldComponent } from './registry.tsx';

export interface GeneratedFormProps {
  descriptors: readonly FieldDescriptor[];
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
  roles?: readonly DiscordRole[] | undefined;
}

export function GeneratedForm({
  descriptors,
  values,
  onChange,
  channels,
  roles,
}: GeneratedFormProps): ReactElement {
  return (
    <div className="generated-form">
      {descriptors.map((descriptor) => {
        const Field = resolveFieldComponent(descriptor);
        return (
          <Field
            key={descriptor.path}
            descriptor={descriptor}
            value={values[descriptor.path]}
            onChange={(value) => onChange(descriptor.path, value)}
            channels={channels}
            roles={roles}
          />
        );
      })}
    </div>
  );
}
