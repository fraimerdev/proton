import { describe, expect, test } from 'bun:test';
import { moduleDescriptorsSchema, moduleIndexSchema } from '@proton/core';
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

describe('the descriptors a settings form fetches instead', () => {
  test('one module costs a fraction of what all of them did', () => {
    const biggest = Math.max(...registry.all().map((m) => bytes(registry.descriptors(m.id))));

    expect(biggest).toBeLessThan(descriptorBytes / 4);
  });

  test('every module the registry knows describes its fields as the schema expects', () => {
    for (const module of registry.all()) {
      const parsed = moduleDescriptorsSchema.safeParse({
        moduleId: module.id,
        descriptors: registry.descriptors(module.id),
      });

      const detail = parsed.success ? '' : ` — ${parsed.error.issues[0]?.message ?? ''}`;

      expect(`${module.id}: ${parsed.success}${detail}`).toBe(`${module.id}: true`);
    }
  });

  // Zod strips unknown keys, so a descriptor that grew a field the schema does not name would
  // reach the browser missing it rather than failing here.
  test('nothing is silently dropped on the way through the schema', () => {
    for (const module of registry.all()) {
      const descriptors = registry.descriptors(module.id);
      const parsed = moduleDescriptorsSchema.parse({ moduleId: module.id, descriptors });

      expect(`${module.id}: ${bytes(parsed.descriptors)}`).toBe(
        `${module.id}: ${bytes(descriptors)}`,
      );
    }
  });
});
