import type { FieldDescriptor, FieldKind } from '@proton/core';
import type { ComponentType } from 'react';
import {
  BooleanFieldInput,
  ChannelIdFieldInput,
  type FieldProps,
  StringFieldInput,
  UnsupportedFieldInput,
} from './fields.tsx';

/**
 * Descriptor kind → component (PLAN.md §9).
 *
 * Adding a field type to the generator is: add the kind in core's descriptor
 * module, add a component, add one entry here. No form, module or route changes.
 */
export const FIELD_COMPONENTS: Record<FieldKind, ComponentType<FieldProps>> = {
  boolean: BooleanFieldInput,
  string: StringFieldInput,
  'channel-id': ChannelIdFieldInput,
};

export function resolveFieldComponent(descriptor: FieldDescriptor): ComponentType<FieldProps> {
  return FIELD_COMPONENTS[descriptor.kind] ?? UnsupportedFieldInput;
}

/** Every kind the generator can currently render. */
export const SUPPORTED_FIELD_KINDS = Object.keys(FIELD_COMPONENTS) as FieldKind[];
