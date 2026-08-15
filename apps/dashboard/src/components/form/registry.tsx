import type { FieldDescriptor, FieldKind } from '@proton/core';
import type { ComponentType } from 'react';
import {
  BooleanFieldInput,
  ChannelIdFieldInput,
  DurationFieldInput,
  EnumFieldInput,
  type FieldProps,
  makeArrayFieldInput,
  NumberFieldInput,
  RoleIdFieldInput,
  StringFieldInput,
  UnsupportedFieldInput,
} from './fields.tsx';

/**
 * Descriptor kind → component (PLAN.md §9).
 *
 * Adding a field type to the generator is: add the kind in core's descriptor
 * module, add a component, add one entry here. No form, module or route changes.
 *
 * Complete as of Gate 1: this covers every kind `FieldKind` declares. It stays
 * `Partial` so a kind added to core later falls through to the loud unsupported
 * placeholder rather than failing to compile the whole dashboard — the form
 * generator's vocabulary is allowed to run ahead of the renderer, as long as it
 * says so out loud.
 */
export const FIELD_COMPONENTS: Partial<Record<FieldKind, ComponentType<FieldProps>>> = {
  boolean: BooleanFieldInput,
  string: StringFieldInput,
  number: NumberFieldInput,
  enum: EnumFieldInput,
  'channel-id': ChannelIdFieldInput,
  'role-id': RoleIdFieldInput,
  duration: DurationFieldInput,
};

function scalarComponent(descriptor: FieldDescriptor): ComponentType<FieldProps> {
  return FIELD_COMPONENTS[descriptor.kind] ?? UnsupportedFieldInput;
}

/**
 * A flat array renders as a repeated scalar control (§9's "flat arrays of
 * those"), so it resolves the element's component and delegates.
 */
const ArrayFieldInput = makeArrayFieldInput(scalarComponent);

export function resolveFieldComponent(descriptor: FieldDescriptor): ComponentType<FieldProps> {
  // An array of a supported kind is not the same control as one of it —
  // rendering a single text box for `string[]` would let an admin overwrite a
  // whole list with one value and never see what they destroyed.
  if (descriptor.array) {
    return FIELD_COMPONENTS[descriptor.kind] ? ArrayFieldInput : UnsupportedFieldInput;
  }
  return scalarComponent(descriptor);
}

/** Every kind the generator can currently render. */
export const SUPPORTED_FIELD_KINDS = Object.keys(FIELD_COMPONENTS) as FieldKind[];
