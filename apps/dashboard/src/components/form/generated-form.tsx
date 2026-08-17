import type { FieldDescriptor } from '@proton/core';
import type { ReactElement } from 'react';
import type { DiscordChannel, DiscordRole } from './fields.tsx';
import { resolveFieldComponent } from './registry.tsx';

export interface FormSection {
  id: string;
  title: string;
  fields: string[];
}

export interface GeneratedFormProps {
  descriptors: readonly FieldDescriptor[];
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
  roles?: readonly DiscordRole[] | undefined;
  sections?: readonly FormSection[] | undefined;
}

export interface DescriptorGroup {
  id: string;
  title: string | null;
  descriptors: FieldDescriptor[];
}

// Claimed by the path's first segment, and anything unclaimed still renders in a trailing group:
// a manifest that forgets a field must not make that field unreachable.
export function groupBySection(
  descriptors: readonly FieldDescriptor[],
  sections: readonly FormSection[] | undefined,
): DescriptorGroup[] {
  if (!sections || sections.length === 0) {
    return [{ id: 'all', title: null, descriptors: [...descriptors] }];
  }

  const claimed = new Set<string>();
  const groups: DescriptorGroup[] = [];

  for (const section of sections) {
    const owned = descriptors.filter((d) => {
      const root = d.path.split('.')[0] ?? d.path;
      return section.fields.includes(root);
    });

    for (const d of owned) claimed.add(d.path);
    if (owned.length > 0) groups.push({ id: section.id, title: section.title, descriptors: owned });
  }

  const rest = descriptors.filter((d) => !claimed.has(d.path));
  if (rest.length > 0) groups.push({ id: 'other', title: null, descriptors: rest });

  return groups;
}

export function GeneratedForm({
  descriptors,
  values,
  onChange,
  channels,
  roles,
  sections,
}: GeneratedFormProps): ReactElement {
  const groups = groupBySection(descriptors, sections);

  return (
    <div className="generated-form">
      {groups.map((group) => (
        <fieldset className="form-section" key={group.id}>
          {group.title ? <legend>{group.title}</legend> : null}
          {group.descriptors.map((descriptor) => {
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
        </fieldset>
      ))}
    </div>
  );
}
