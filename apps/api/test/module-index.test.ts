import { describe, expect, test } from 'bun:test';
import { fieldDescriptorSchema, moduleIndexSchema } from '@proton/core';
import { createModuleRegistry } from '@proton/modules';
import { moduleIndex } from '../src/app.ts';

const registry = createModuleRegistry();
const index = moduleIndex(registry, {});

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const descriptorBytes = bytes(registry.all().map((m) => registry.descriptors(m.id)));

describe('the module index the dashboard reads on every guild page load', () => {
  test('the descriptors it used to carry are worth leaving out', () => {
    expect(registry.all().length).toBeGreaterThan(20);
    expect(descriptorBytes).toBeGreaterThan(20_000);
  });

  test('it carries a path and a label per field, and no descriptors', () => {
    expect(bytes(index)).toBeLessThan(descriptorBytes);

    for (const module of index.modules) {
      expect(`${module.id}: ${'descriptors' in module}`).toBe(`${module.id}: false`);

      for (const field of module.fields) {
        expect(Object.keys(field).sort()).toEqual(['label', 'path']);
      }
    }
  });

  test('a field the palette can find still exists for a module that has settings', () => {
    const automod = index.modules.find((m) => m.id === 'automod');

    expect(automod?.fields.length).toBeGreaterThan(0);
  });

  test('and the whole thing satisfies the schema both apps derive their types from', () => {
    expect(moduleIndexSchema.safeParse(index).success).toBe(true);
  });
});

/**
 * The dashboard stopped fetching these when its settings pages became hand-written React, and the
 * endpoint that served them is gone. The generator is not: `descriptorsToModal` still renders the
 * same descriptors as an in-Discord modal, and the module index above still reads a path and a
 * label off each one. A module whose schema stops describing itself breaks both.
 */
describe('the descriptors the in-Discord builder still renders', () => {
  test('every module the registry knows describes its fields as the schema expects', () => {
    for (const module of registry.all()) {
      for (const descriptor of registry.descriptors(module.id)) {
        const parsed = fieldDescriptorSchema.safeParse(descriptor);
        const detail = parsed.success ? '' : ` — ${parsed.error.issues[0]?.message ?? ''}`;

        expect(`${module.id}/${descriptor.path}: ${parsed.success}${detail}`).toBe(
          `${module.id}/${descriptor.path}: true`,
        );
      }
    }
  });

  // Zod strips unknown keys, so a descriptor that grew a field the schema does not name would
  // reach the modal builder missing it rather than failing here.
  test('nothing is silently dropped on the way through the schema', () => {
    for (const module of registry.all()) {
      for (const descriptor of registry.descriptors(module.id)) {
        expect(
          `${module.id}/${descriptor.path}: ${bytes(fieldDescriptorSchema.parse(descriptor))}`,
        ).toBe(`${module.id}/${descriptor.path}: ${bytes(descriptor)}`);
      }
    }
  });
});
