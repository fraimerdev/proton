import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULE_ROUTE_IDS } from '../src/components/module/paths.ts';
import {
  configurableDescriptors,
  MODULE_SWITCH_PATH,
} from '../src/components/shell/module-meta.ts';

const SRC = join(import.meta.dir, '..', 'src');
const ROUTES = join(SRC, 'routes', 'dashboard', '$guildId');

// index.tsx is the module list; every other file here is one module's hand-written settings page.
const ROUTE_IDS = readdirSync(ROUTES)
  .filter((name) => name.endsWith('.tsx') && name !== 'index.tsx')
  .map((name) => name.slice(0, -'.tsx'.length))
  .sort();

function sourceOf(moduleId: string): string {
  return readFileSync(join(ROUTES, `${moduleId}.tsx`), 'utf8');
}

/**
 * Every config path a page binds a control to: the `path` prop of the shared inputs, plus the
 * `form.set` calls the bespoke editors write through instead of a path prop. Reads (`form.value`)
 * do not count — a page may legitimately read the stored `enabled` to describe the module without
 * offering a second control for it.
 */
function boundPaths(source: string): string[] {
  return [
    ...[...source.matchAll(/path=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map(
      (match) => match[1] ?? match[2] ?? '',
    ),
    ...[...source.matchAll(/form\.set\('([^']+)'/g)].map((match) => match[1] ?? ''),
  ];
}

function field(path: string) {
  return { path, kind: 'boolean', label: path, optional: false };
}

describe('the module switch is not also a form field', () => {
  test('the switch path is dropped, and nothing else is', () => {
    const kept = configurableDescriptors([
      field(MODULE_SWITCH_PATH),
      field('welcomeChannelId'),
      field('welcomeMessage'),
    ]);

    expect(kept.map((d) => d.path)).toEqual(['welcomeChannelId', 'welcomeMessage']);
  });

  // A nested field that merely ends in the same word is a different setting — announcements has
  // per-announcement `enabled` flags, and dropping those would hide real configuration.
  test('a nested field whose leaf is also called enabled survives', () => {
    const kept = configurableDescriptors([field(MODULE_SWITCH_PATH), field('saved.enabled')]);

    expect(kept.map((d) => d.path)).toEqual(['saved.enabled']);
  });
});

/**
 * The generated form used to filter the switch out of the descriptors it was handed. There is no
 * generated form any more: each module writes its own fields, so the same invariant is now kept by
 * every one of those pages declining to bind a control to the switch path. The palette is still
 * fed by the module index, so it still filters through the helper.
 */
describe('nothing on a module page is a second copy of the switch', () => {
  // If this list drifts the sweep below silently stops covering the pages it lost.
  test('the sweep sees every routed module', () => {
    expect(ROUTE_IDS).toEqual([...MODULE_ROUTE_IDS]);
  });

  // If the extraction stops matching the real syntax, every page reads as binding nothing and the
  // sweep passes without looking at anything.
  test('the paths parse out of every route source at all', () => {
    for (const moduleId of ROUTE_IDS) {
      expect(`${moduleId}: ${boundPaths(sourceOf(moduleId)).length > 0}`).toBe(`${moduleId}: true`);
    }
  });

  test('no module page binds a control to the switch path', () => {
    for (const moduleId of ROUTE_IDS) {
      expect(`${moduleId}: ${boundPaths(sourceOf(moduleId)).includes(MODULE_SWITCH_PATH)}`).toBe(
        `${moduleId}: false`,
      );
    }
  });

  // The other half of "one control cannot disagree with another": the switch does exist, once, as
  // chrome above the tabs, and it writes through the toggle mutation rather than the settings form.
  test('the header owns the one switch there is', () => {
    const header = readFileSync(join(SRC, 'components', 'shell', 'module-header.tsx'), 'utf8');

    expect(header).toContain('useToggleModule');
    expect(header).toContain('role="switch"');
    expect(boundPaths(header)).toEqual([]);
  });

  test('the command palette still filters through the helper', () => {
    const shell = readFileSync(join(SRC, 'components', 'shell', 'app-shell.tsx'), 'utf8');

    // The palette filters the path-and-label pairs the module index carries for all the modules.
    expect(shell).toContain('configurableDescriptors(module.fields)');
  });

  // Every module config carries its own `enabled` alongside the guild_modules row, and the worker
  // reads either being false as off. With the field off every page, the header's master switch is
  // the only way to set it — so the write has to carry both or a switched-on module would sit dead
  // on a stored config saying otherwise.
  test('the API mirrors the switch into the stored config', () => {
    const service = readFileSync(
      join(SRC, '..', '..', 'api', 'src', 'modules', 'service.ts'),
      'utf8',
    );

    expect(service).toContain('enabled: input.enabled');
    expect(service).not.toContain('const nextConfigRaw = input.config ?? before.config;');
  });
});
