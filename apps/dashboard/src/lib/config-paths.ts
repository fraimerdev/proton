import type { FieldDescriptor } from '@proton/core';

export function getAtPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

export function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return target;

  let cursor: Record<string, unknown> = target;
  for (const key of keys) {
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  cursor[last] = value;
  return target;
}

export function toFormValues(
  descriptors: readonly FieldDescriptor[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const descriptor of descriptors) {
    const current = getAtPath(config, descriptor.path);
    values[descriptor.path] = current === undefined ? descriptor.defaultValue : current;
  }
  return values;
}

export function toConfig(
  descriptors: readonly FieldDescriptor[],
  values: Record<string, unknown>,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const config = structuredClone(base);
  for (const descriptor of descriptors) {
    setAtPath(config, descriptor.path, values[descriptor.path]);
  }
  return config;
}
