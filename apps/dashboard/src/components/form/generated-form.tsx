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

/**
 * Renders a module's whole config form from its descriptors.
 *
 * There is no per-module form code anywhere in the dashboard: this walks
 * whatever the module's Zod schema produced. Adding a config field to a module
 * changes exactly one file — the module's schema (PLAN.md P4).
 */
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
