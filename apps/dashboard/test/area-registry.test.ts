import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { areaForField, areasFor, MODULE_AREAS } from '../src/components/module/area-index.ts';
import { activeArea, resolveArea } from '../src/components/module/areas.ts';
import { hasModulePage } from '../src/components/module/paths.ts';
import { MODULE_SWITCH_PATH } from '../src/components/shell/module-meta.ts';

const ROUTES = join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId');

const AREA_MODULES = Object.keys(MODULE_AREAS);

function sourceOf(moduleId: string): string {
  return readFileSync(join(ROUTES, `${moduleId}.tsx`), 'utf8');
}

/**
 * The route file's top-level function declarations, sliced on the column-zero closing brace biome
 * guarantees. Importing the route instead would pull the router, three lazy editors and the card
 * rasteriser into a test that only needs to know which paths each area renders.
 */
function bodies(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const lines = source.split('\n');

  let name: string | undefined;
  let start = 0;

  lines.forEach((line, index) => {
    const opens = /^function ([A-Za-z0-9_]+)/.exec(line);

    if (opens) {
      name = opens[1];
      start = index;
    } else if (name !== undefined && line === '}') {
      found.set(name, lines.slice(start, index + 1).join('\n'));
      name = undefined;
    }
  });

  return found;
}

// The first segment, not the whole path: an area declares `rankCard` and the input renders
// `rankCard.background`, and serverlog's toggles are `categories.${category.key}` templates whose
// tail is only known at runtime.
function rootOf(path: string): string {
  return path.split('.')[0] ?? '';
}

/**
 * The config roots a component writes: the `path` prop of every input, plus every `form.set` for
 * the bespoke editors that have no path prop of their own. Reads (`form.value`) deliberately do not
 * count — the templates area reads the component palette to offer it for insertion, and counting
 * that would claim `components` for two areas at once.
 */
function writesIn(body: string): string[] {
  const roots = [...body.matchAll(/path=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((match) =>
    rootOf(match[1] ?? match[2] ?? ''),
  );

  return [
    ...roots,
    ...[...body.matchAll(/form\.set\('([^']+)'/g)].map((match) => rootOf(match[1] ?? '')),
  ];
}

// The area component named by the `area.id === '…' ? <X /> : null` dispatch every area'd route uses.
function componentFor(source: string, areaId: string): string | undefined {
  return new RegExp(`area\\.id === '${areaId}' \\? <([A-Za-z0-9]+)`).exec(source)?.[1];
}

/**
 * Everything an area writes, following the route file's own helper components — leveling's earning
 * area renders its XP range through `XpRange`, so stopping at the area component would report two
 * fields as unrendered that a reader can plainly see on the page.
 */
function writtenBy(source: string, areaId: string): string[] {
  const all = bodies(source);
  const entry = componentFor(source, areaId);

  const seen = new Set<string>();
  const roots: string[] = [];

  function walk(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);

    const body = all.get(name);
    if (body === undefined) return;

    roots.push(...writesIn(body));

    for (const match of body.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
      const child = match[1] ?? '';
      if (all.has(child)) walk(child);
    }
  }

  if (entry !== undefined) walk(entry);

  return [...new Set(roots)];
}

describe('the area index reads the real route files', () => {
  test('it registers at least one module, or everything below proves nothing', () => {
    expect(AREA_MODULES.length).toBeGreaterThan(0);
  });

  test('every area’d module has a page for its hub to sit on', () => {
    for (const moduleId of AREA_MODULES) {
      expect(`${moduleId}: ${hasModulePage(moduleId)}`).toBe(`${moduleId}: true`);
    }
  });

  // If the dispatch stops matching, every check below reads an empty area and passes vacuously.
  test('every area is dispatched to a component of its route file', () => {
    for (const moduleId of AREA_MODULES) {
      const source = sourceOf(moduleId);

      for (const area of areasFor(moduleId)) {
        expect(
          `${moduleId}/${area.id} -> ${componentFor(source, area.id) ?? 'nothing'}`,
        ).not.toContain('nothing');
      }
    }
  });

  test('the paths parse out of the route source at all', () => {
    for (const moduleId of AREA_MODULES) {
      const source = sourceOf(moduleId);

      for (const area of areasFor(moduleId)) {
        expect(`${moduleId}/${area.id}: ${writtenBy(source, area.id).length > 0}`).toBe(
          `${moduleId}/${area.id}: true`,
        );
      }
    }
  });
});

/**
 * `fields` used to be the module manifest's `dashboard.sections`, checked against a generic form
 * that rendered from the same descriptors. Nothing joins them now: the route file renders whatever
 * it renders and the index says whatever it says, so the two only agree because this suite makes
 * them. A field listed here but not rendered sends a palette jump to a page the field is not on;
 * a field rendered but not listed is one the palette cannot reach at all.
 */
describe('the index and the route agree on what an area holds', () => {
  test('every field an area declares is really rendered by that area', () => {
    for (const moduleId of AREA_MODULES) {
      const source = sourceOf(moduleId);

      for (const area of areasFor(moduleId)) {
        const rendered = new Set(writtenBy(source, area.id));

        for (const field of area.fields) {
          expect(`${moduleId}/${area.id} -> ${field}: ${rendered.has(field)}`).toBe(
            `${moduleId}/${area.id} -> ${field}: true`,
          );
        }
      }
    }
  });

  test('every field an area renders is one it declares', () => {
    for (const moduleId of AREA_MODULES) {
      const source = sourceOf(moduleId);

      for (const area of areasFor(moduleId)) {
        const declared = new Set(area.fields);

        for (const field of writtenBy(source, area.id)) {
          expect(`${moduleId}/${area.id} -> ${field}: ${declared.has(field)}`).toBe(
            `${moduleId}/${area.id} -> ${field}: true`,
          );
        }
      }
    }
  });
});

/**
 * The hub is the only way into an area'd module's settings, so anything no area claims can no
 * longer be reached at all — and a field two areas claim is worse than a duplicate: areaForField
 * answers with the first, so the palette jump lands on a page whose hash matches nothing.
 */
describe('nothing becomes unreachable', () => {
  test('every field the module renders belongs to exactly one area', () => {
    for (const moduleId of AREA_MODULES) {
      const source = sourceOf(moduleId);
      const claims = new Map<string, string[]>();

      for (const area of areasFor(moduleId)) {
        for (const field of writtenBy(source, area.id)) {
          claims.set(field, [...(claims.get(field) ?? []), area.id]);
        }
      }

      for (const [field, holders] of claims) {
        expect(`${moduleId}/${field} claimed by: ${holders.join(', ')}`).toBe(
          `${moduleId}/${field} claimed by: ${holders[0] ?? 'nobody'}`,
        );
      }
    }
  });

  // The switch is chrome, drawn beside the module's name on every page including the hub. An area
  // claiming it would put a second copy of it inside one sub-page and none on the others.
  test('no area claims the module switch', () => {
    for (const moduleId of AREA_MODULES) {
      for (const area of areasFor(moduleId)) {
        expect(`${moduleId}/${area.id}: ${area.fields.includes(MODULE_SWITCH_PATH)}`).toBe(
          `${moduleId}/${area.id}: false`,
        );
      }
    }
  });
});

describe('resolveArea', () => {
  const moduleId = AREA_MODULES[0] ?? 'leveling';
  const areas = areasFor(moduleId);

  test('no area parameter opens the hub rather than throwing', () => {
    expect(resolveArea(moduleId, areas, undefined)).toBeUndefined();
  });

  test('a registered id resolves to its entry', () => {
    const first = areas[0];

    expect(resolveArea(moduleId, areas, first?.id)).toBe(first);
  });

  test('an unknown id names the areas the module does have', () => {
    const names = areas.map((area) => `'${area.id}'`);

    expect(() => resolveArea(moduleId, areas, 'widgets')).toThrow(
      `The '${moduleId}' module has no 'widgets' area — it has ${names.join(', ')}. Remove the area parameter from the address bar to open it.`,
    );
  });

  test('a module with no areas says its settings are one page', () => {
    expect(() => resolveArea('ping', areasFor('ping'), 'anything')).toThrow(
      'its settings are one page',
    );
  });

  test('a non-string area is described rather than dying as a raw type error', () => {
    expect(() => resolveArea(moduleId, areas, 7)).toThrow("no '7' area");
  });

  test('areasFor never answers for a prototype key', () => {
    expect(areasFor('constructor')).toEqual([]);
    expect(activeArea(areasFor('constructor'), 'x')).toBeUndefined();
  });
});

describe('areaForField', () => {
  test('finds the area holding a nested path', () => {
    expect(areaForField('leveling', 'rankCard.background')?.id).toBe('card');
  });

  test('finds the area holding a flat path', () => {
    expect(areaForField('leveling', 'voiceXpPerMinute')?.id).toBe('earning');
  });

  // Every field of an area'd module has to answer, and answer with the area that actually draws it,
  // or the palette jump lands on the hub — or on a sibling sub-page — with a hash nothing matches.
  test('answers for every field of every area’d module, with the area that renders it', () => {
    for (const moduleId of AREA_MODULES) {
      const source = sourceOf(moduleId);

      for (const area of areasFor(moduleId)) {
        for (const field of writtenBy(source, area.id)) {
          expect(`${moduleId}/${field}: ${areaForField(moduleId, field)?.id ?? 'nowhere'}`).toBe(
            `${moduleId}/${field}: ${area.id}`,
          );
        }
      }
    }
  });

  test('a module with no areas sends the palette to its one settings page', () => {
    expect(areaForField('ping', 'response')).toBeUndefined();
  });
});
