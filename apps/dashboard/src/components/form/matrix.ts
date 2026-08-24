import type { FieldDescriptor } from '@proton/core';

export interface MatrixColumn {
  root: string;
  label: string;

  // Overrides the picker's own "not set" copy, where empty means something the schema cannot say.
  emptyLabel?: string;
}

export interface MatrixSpec {
  rows: string;
  columns: readonly MatrixColumn[];
}

export interface MatrixRow {
  key: string;
  label: string;
  cells: (FieldDescriptor | undefined)[];
}

export interface MatrixLayout {
  spec: MatrixSpec;
  rows: MatrixRow[];
  rest: FieldDescriptor[];
}

/**
 * Sections whose fields are two parallel objects over one set of keys — a table, declared as a
 * list of rows in the manifest because the form generator refuses to nest twice. Held here beside
 * the areas and panels registries for the same reason they are: the column names are dashboard
 * copy, and a module tells the worker what it does by doing it.
 */
export const MODULE_MATRICES: Readonly<Record<string, Readonly<Record<string, MatrixSpec>>>> = {
  serverlog: {
    categories: {
      rows: 'Category',
      columns: [
        { root: 'categories', label: 'Logged' },
        { root: 'categoryChannels', label: 'Channel', emptyLabel: 'Inherit' },
      ],
    },
  },
};

export function matrixFor(moduleId: string | undefined, sectionId: string): MatrixSpec | undefined {
  if (moduleId === undefined || !Object.hasOwn(MODULE_MATRICES, moduleId)) return undefined;

  const held = MODULE_MATRICES[moduleId];
  if (!held || !Object.hasOwn(held, sectionId)) return undefined;

  return held[sectionId];
}

function leafOf(path: string): string | undefined {
  const parts = path.split('.');

  return parts.length > 1 ? parts[parts.length - 1] : undefined;
}

/**
 * Turns a section's descriptors into one row per leaf key. Returns undefined rather than a broken
 * table whenever the shape stops holding — a renamed root, a leaf only one column has — so a
 * schema change downgrades to the plain rows it always had instead of dropping fields.
 */
export function toMatrix(
  descriptors: readonly FieldDescriptor[],
  spec: MatrixSpec,
): MatrixLayout | undefined {
  const roots = new Set(spec.columns.map((column) => column.root));
  const claimed = descriptors.filter((descriptor) => {
    const root = descriptor.path.split('.')[0] ?? '';

    return roots.has(root) && leafOf(descriptor.path) !== undefined;
  });

  const order: string[] = [];
  const byLeaf = new Map<string, Map<string, FieldDescriptor>>();

  for (const descriptor of claimed) {
    const leaf = leafOf(descriptor.path) ?? '';
    const root = descriptor.path.split('.')[0] ?? '';

    if (!byLeaf.has(leaf)) {
      byLeaf.set(leaf, new Map());
      order.push(leaf);
    }

    byLeaf.get(leaf)?.set(root, descriptor);
  }

  const rows: MatrixRow[] = order.map((leaf) => {
    const cells = byLeaf.get(leaf) ?? new Map();
    const first = spec.columns.map((column) => cells.get(column.root)).find(Boolean);

    return {
      key: leaf,
      label: first?.label ?? leaf,
      cells: spec.columns.map((column) => cells.get(column.root)),
    };
  });

  // A table needs every column populated on at least two rows, or it is a list wearing a header.
  const full = rows.filter((row) => row.cells.every(Boolean));
  if (full.length < 2 || full.length !== rows.length) return undefined;

  const inMatrix = new Set(claimed.map((descriptor) => descriptor.path));

  return {
    spec,
    rows,
    rest: descriptors.filter((descriptor) => !inMatrix.has(descriptor.path)),
  };
}
