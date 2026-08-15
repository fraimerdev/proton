import type { FieldDescriptor } from '@proton/core';

/**
 * Descriptors address fields by dot path (`limits.strict`) because the form is
 * flat while the config object may nest one level. These convert between the
 * two shapes.
 */

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

/** Flat form state from a stored config, falling back to declared defaults. */
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

/**
 * Rebuild the nested config object from flat form state, over the config the
 * page loaded.
 *
 * The base matters: a module may legitimately store fields the generator does
 * not render — cases' escalation ladder, permissions' override map — and
 * building the object from descriptors alone would drop them, whereupon the
 * module's schema would fill them back in from `.default()` and an admin would
 * watch an unrelated setting reset itself because they toggled a checkbox.
 *
 * Reusing the loaded config as the base is safe precisely because it came from
 * `ModuleConfigService.get`, which returns the *parsed* object — Zod strips keys
 * the schema no longer declares, so a field removed from the schema cannot ride
 * along here and reappear (I5).
 */
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
