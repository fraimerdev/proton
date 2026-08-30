import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULES } from '@proton/modules';
import { hasModulePage, MODULE_ROUTE_IDS, modulePath } from '../src/components/module/paths.ts';

const SRC = join(import.meta.dir, '..', 'src');
const ROUTES = join(SRC, 'routes', 'dashboard', '$guildId');
const REGISTRY = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'packages',
  'modules',
  'registry',
  'src',
  'index.ts',
);

const SHIPPED = MODULES.map((manifest) => manifest.id).sort();
const LISTED: string[] = [...MODULE_ROUTE_IDS].sort();

// index.tsx is the module list; every other file here is one module's hand-written settings page.
const ROUTE_FILES = readdirSync(ROUTES)
  .filter((name) => name.endsWith('.tsx') && name !== 'index.tsx')
  .sort();

const ROUTE_IDS = ROUTE_FILES.map((name) => name.slice(0, -'.tsx'.length));

function sourceOf(moduleId: string): string {
  return readFileSync(join(ROUTES, `${moduleId}.tsx`), 'utf8');
}

/**
 * MODULE_ROUTE_IDS is hand-maintained, so it can only be checked against something that is not.
 * `MODULES` is what the worker actually boots, which is the definition of "a module the bot ships";
 * everything below is worthless if that list arrives empty or truncated.
 */
describe('the list this suite measures against is the real one', () => {
  test('the bot ships modules at all', () => {
    expect(SHIPPED.length).toBeGreaterThan(0);
  });

  test('no module package is imported by the registry but left out of the build', () => {
    const imported = [
      ...new Set(
        [...readFileSync(REGISTRY, 'utf8').matchAll(/from '@proton\/module-([a-z]+)'/g)].map(
          (match) => match[1] ?? '',
        ),
      ),
    ].sort();

    expect(imported).toEqual(SHIPPED);
  });
});

/**
 * The drift this guards runs both ways, and neither end announces itself. A module shipped
 * server-side with no id here has `modulePath` return undefined, so the module list renders it as
 * an unreachable row nobody can open. An id here for a module that no longer exists points the
 * list at a page whose loader throws, because the API never names that module.
 */
describe('MODULE_ROUTE_IDS holds one id per shipped module', () => {
  test('every shipped module has a page', () => {
    expect(SHIPPED.filter((id) => !LISTED.includes(id))).toEqual([]);
  });

  test('no page outlives its module', () => {
    expect(LISTED.filter((id) => !SHIPPED.includes(id))).toEqual([]);
  });

  // Duplicates would still satisfy both filters above while making the list disagree with itself.
  test('no id is listed twice', () => {
    expect(new Set(MODULE_ROUTE_IDS).size).toBe(MODULE_ROUTE_IDS.length);
  });
});

describe('exactly one route file backs each id', () => {
  test('every id has a route file to open', () => {
    for (const id of MODULE_ROUTE_IDS) {
      expect(`${id}: ${existsSync(join(ROUTES, `${id}.tsx`))}`).toBe(`${id}: true`);
    }
  });

  test('no route file sits outside the list', () => {
    expect(ROUTE_IDS).toEqual(LISTED);
  });

  // The one generic page every module used to render through. Were it to come back, it would match
  // ids this list has never heard of and quietly resurrect the form that no longer exists.
  test('the catch-all module route is gone', () => {
    expect(ROUTE_FILES).not.toContain('$moduleId.tsx');
  });
});

/**
 * A route file named for one module can perfectly well load another's config — the filename, the
 * `createFileRoute` path and the `moduleRoute` argument are three separate strings, and only the
 * first is what `modulePath` sends a link to. Copying a page to start a new module is exactly how
 * they come apart.
 */
describe('each page is wired to the module it is named for', () => {
  test('the file route path is the path modulePath hands out', () => {
    for (const id of MODULE_ROUTE_IDS) {
      expect(`${id}: ${sourceOf(id).includes(`createFileRoute('${modulePath(id)}')`)}`).toBe(
        `${id}: true`,
      );
    }
  });

  test('the config it loads is the module in its path', () => {
    for (const id of MODULE_ROUTE_IDS) {
      const loaded = /moduleRoute\('([^']+)'/.exec(sourceOf(id))?.[1];

      expect(`${id} -> ${loaded ?? 'nothing'}`).toBe(`${id} -> ${id}`);
    }
  });

  // A route file the plugin has not picked up compiles and tests fine while being unreachable.
  test('the generated tree registers every page', () => {
    const tree = readFileSync(join(SRC, 'routeTree.gen.ts'), 'utf8');

    for (const id of MODULE_ROUTE_IDS) {
      expect(`${id}: ${tree.includes(`'/dashboard/$guildId/${id}'`)}`).toBe(`${id}: true`);
    }
  });
});

describe('modulePath', () => {
  test('answers for every module the bot ships', () => {
    for (const id of SHIPPED) {
      expect(`${id}: ${modulePath(id) ?? 'nothing'}`).toBe(`${id}: /dashboard/$guildId/${id}`);
    }
  });

  test('a module with no page reads as unreachable rather than as a link to a 404', () => {
    expect(hasModulePage('embeds')).toBe(false);
    expect(modulePath('embeds')).toBeUndefined();
  });

  test('never answers for a prototype key', () => {
    expect(hasModulePage('constructor')).toBe(false);
    expect(modulePath('toString')).toBeUndefined();
  });
});
