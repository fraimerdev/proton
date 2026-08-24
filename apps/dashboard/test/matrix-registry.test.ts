import { describe, expect, test } from 'bun:test';
import { zodToDescriptors } from '@proton/core';
import { serverlogFormSchema } from '@proton/module-serverlog/config';
import { MODULE_MATRICES, matrixFor, toMatrix } from '../src/components/form/matrix.ts';

const SCHEMAS: Record<string, Parameters<typeof zodToDescriptors>[0]> = {
  serverlog: serverlogFormSchema,
};

describe('the matrix registry reads real modules', () => {
  test('it declares at least one, or everything below proves nothing', () => {
    expect(Object.keys(MODULE_MATRICES).length).toBeGreaterThan(0);
  });

  /**
   * toMatrix returns undefined the moment the shape stops holding, and the section falls back to
   * plain rows — correct, but silent. A declared matrix that stopped building is a section quietly
   * reverting to the twenty-six-row form this registry exists to replace.
   */
  test('every declared matrix still builds against its module’s real schema', () => {
    for (const [moduleId, sections] of Object.entries(MODULE_MATRICES)) {
      const schema = SCHEMAS[moduleId];
      if (!schema) throw new Error(`no form schema wired up for '${moduleId}'`);

      const descriptors = zodToDescriptors(schema);

      for (const sectionId of Object.keys(sections)) {
        const spec = matrixFor(moduleId, sectionId);
        if (!spec) throw new Error(`matrixFor lost '${moduleId}/${sectionId}'`);

        const roots = new Set(spec.columns.map((column) => column.root));
        const owned = descriptors.filter((d) => roots.has(d.path.split('.')[0] ?? ''));
        const built = toMatrix(owned, spec);

        expect(`${moduleId}/${sectionId} builds: ${built !== undefined}`).toBe(
          `${moduleId}/${sectionId} builds: true`,
        );
      }
    }
  });

  test('every column names a path root the schema actually has', () => {
    for (const [moduleId, sections] of Object.entries(MODULE_MATRICES)) {
      const schema = SCHEMAS[moduleId];
      if (!schema) continue;

      const roots = new Set(zodToDescriptors(schema).map((d) => d.path.split('.')[0] ?? ''));

      for (const [sectionId, spec] of Object.entries(sections)) {
        for (const column of spec.columns) {
          expect(`${moduleId}/${sectionId} -> ${column.root}: ${roots.has(column.root)}`).toBe(
            `${moduleId}/${sectionId} -> ${column.root}: true`,
          );
        }
      }
    }
  });

  test('the serverlog table is one row per log category, not one per field', () => {
    const spec = matrixFor('serverlog', 'categories');
    if (!spec) throw new Error('serverlog/categories is not declared');

    const descriptors = zodToDescriptors(serverlogFormSchema);
    const roots = new Set(spec.columns.map((column) => column.root));
    const owned = descriptors.filter((d) => roots.has(d.path.split('.')[0] ?? ''));

    const built = toMatrix(owned, spec);
    expect(built).toBeDefined();
    if (!built) return;

    expect(built.rows.length * spec.columns.length).toBe(owned.length);
    expect(built.rest).toEqual([]);
    expect(built.rows.map((row) => row.key)).toContain('server');
  });

  test('matrixFor never answers for a prototype key', () => {
    expect(matrixFor('constructor', 'categories')).toBeUndefined();
    expect(matrixFor('serverlog', 'constructor')).toBeUndefined();
    expect(matrixFor(undefined, 'categories')).toBeUndefined();
  });
});
