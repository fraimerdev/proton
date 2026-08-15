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

const ArrayFieldInput = makeArrayFieldInput(scalarComponent);

export function resolveFieldComponent(descriptor: FieldDescriptor): ComponentType<FieldProps> {
  if (descriptor.array) {
    return FIELD_COMPONENTS[descriptor.kind] ? ArrayFieldInput : UnsupportedFieldInput;
  }
  return scalarComponent(descriptor);
}

export const SUPPORTED_FIELD_KINDS = Object.keys(FIELD_COMPONENTS) as FieldKind[];
