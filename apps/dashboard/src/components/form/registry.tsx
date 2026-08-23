import type { FieldDescriptor, FieldKind } from '@proton/core';
import type { ComponentType } from 'react';
import {
  ArrayFieldInput,
  BooleanFieldInput,
  ChannelIdFieldInput,
  ColourFieldInput,
  DurationFieldInput,
  EnumFieldInput,
  type FieldProps,
  NumberFieldInput,
  RoleIdFieldInput,
  StringFieldInput,
  TOKEN_KINDS,
  UnsupportedFieldInput,
} from './fields.tsx';

export const FIELD_COMPONENTS: Partial<Record<FieldKind, ComponentType<FieldProps>>> = {
  boolean: BooleanFieldInput,
  string: StringFieldInput,
  number: NumberFieldInput,
  colour: ColourFieldInput,
  enum: EnumFieldInput,
  'channel-id': ChannelIdFieldInput,
  'role-id': RoleIdFieldInput,
  duration: DurationFieldInput,
};

function scalarComponent(descriptor: FieldDescriptor): ComponentType<FieldProps> {
  return FIELD_COMPONENTS[descriptor.kind] ?? UnsupportedFieldInput;
}

// Narrower than FIELD_COMPONENTS: a colour has a scalar control but no sensible chip, so a list of
// them is refused out loud rather than rendered as a row of hex strings nobody can edit.
export function resolveFieldComponent(descriptor: FieldDescriptor): ComponentType<FieldProps> {
  if (descriptor.array) {
    return TOKEN_KINDS.includes(descriptor.kind) ? ArrayFieldInput : UnsupportedFieldInput;
  }
  return scalarComponent(descriptor);
}

export const SUPPORTED_FIELD_KINDS = Object.keys(FIELD_COMPONENTS) as FieldKind[];
