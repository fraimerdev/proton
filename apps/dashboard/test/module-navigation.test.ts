import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { areasFor } from '../src/components/module/area-index.ts';
import { settingsSurvives } from '../src/components/module/navigation.ts';
import { SETTINGS_TAB, savedLine, tabsFor } from '../src/components/module/page.tsx';
import { MODULE_ROUTE_IDS } from '../src/components/module/paths.ts';
import { paletteIndex, paletteResults } from '../src/components/shell/app-shell.tsx';
import { BROWSE_VIEWS } from '../src/components/shell/module-meta.ts';

const ROUTES = join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId');

function sourceOf(moduleId: string): string {
  return readFileSync(join(ROUTES, `${moduleId}.tsx`), 'utf8');
}

function at(pathname: string, search: Record<string, unknown> = {}) {
  return { pathname, search };
}

const AUTOMOD = '/dashboard/1/automod';
const TICKETS = '/dashboard/1/tickets';

// Whether the module has sub-pages is now the caller's to state, not settingsSurvives' to look up:
// tickets and cases have none, automod does. The block below pins each route to the right answer.
const NO_AREAS = false;
const HAS_AREAS = true;

describe('what counts as leaving the settings form', () => {
  test('a module with no areas keeps its form across a hash jump', () => {
    expect(settingsSurvives(at(TICKETS), at(TICKETS), NO_AREAS)).toBe(true);
  });

  test('opening another module leaves it', () => {
    expect(settingsSurvives(at(TICKETS), at(AUTOMOD), NO_AREAS)).toBe(false);
  });

  test('switching to a data view leaves it', () => {
    expect(
      settingsSurvives(
        at('/dashboard/1/cases'),
        at('/dashboard/1/cases', { view: 'cases' }),
        NO_AREAS,
      ),
    ).toBe(false);
  });

  test('moving between two areas keeps it, so nothing is confirmed that cannot be lost', () => {
    expect(
      settingsSurvives(
        at(AUTOMOD, { area: 'checks' }),
        at(AUTOMOD, { area: 'response' }),
        HAS_AREAS,
      ),
    ).toBe(true);
  });

  /**
   * The hub replaces the whole settings subtree, so this move unmounts the form and drops every
   * unsaved edit in it. It used to pass the blocker untouched — same pathname, same view — and
   * discard the work with no confirmation at all.
   */
  test('leaving the last area for the hub does not keep it', () => {
    expect(settingsSurvives(at(AUTOMOD, { area: 'checks' }), at(AUTOMOD), HAS_AREAS)).toBe(false);
  });

  test('arriving at an area from the hub does not keep it either', () => {
    expect(settingsSurvives(at(AUTOMOD), at(AUTOMOD, { area: 'checks' }), HAS_AREAS)).toBe(false);
  });
});

/**
 * settingsSurvives used to read the area table off the module id it was handed. Each route file now
 * asserts its own answer through useModuleForm's third argument, and the argument defaults to false
 * — so an area'd module that forgets it loses the two tests above: the hub swallows the edits with
 * no confirmation, exactly the bug the comment there describes.
 */
describe('every route states the areas it has, so the blocker asks the right question', () => {
  const AREA_MODULES = MODULE_ROUTE_IDS.filter((moduleId) => areasFor(moduleId).length > 0);

  test('the six modules with sub-pages are the six that claim them', () => {
    expect([...AREA_MODULES]).toEqual([
      'automod',
      'honeypot',
      'leveling',
      'messages',
      'serverlog',
      'welcome',
    ]);
  });

  const claimsAreas = (moduleId: string): boolean =>
    sourceOf(moduleId).includes(`useModuleForm(guildId, '${moduleId}', true`);

  test('a module with areas passes true rather than taking the default', () => {
    expect(AREA_MODULES.filter((moduleId) => !claimsAreas(moduleId))).toEqual([]);
  });

  // The mirror: a module with no hub must not claim one, or every hash jump inside its one page
  // raises the discard dialog on a move that unmounts nothing.
  test('a module with none never claims to have them', () => {
    expect(
      MODULE_ROUTE_IDS.filter((moduleId) => areasFor(moduleId).length === 0).filter(claimsAreas),
    ).toEqual([]);
  });
});

describe('the settings tab round-trips', () => {
  // A route file cannot be imported — it reaches lib/queries and through it the database at module
  // scope — so the ids and titles come from the sidebar's copy, which view-registry.test.tsx holds
  // equal to what the routes actually declare.
  const LEVELING_VIEWS = BROWSE_VIEWS.filter((entry) => entry.moduleId === 'leveling').map(
    (entry) => ({ id: entry.viewId, title: entry.title }),
  );

  test('with an area open it carries the area, so the current tab is not a way off the page', () => {
    const tabs = tabsFor(LEVELING_VIEWS, undefined, 'rewards');
    const settings = tabs.find((tab) => tab.key === SETTINGS_TAB);

    expect(settings?.current).toBe(true);
    expect(settings?.search).toEqual({ area: 'rewards' });
  });

  test('with no area it stays a bare settings link', () => {
    expect(
      tabsFor(LEVELING_VIEWS, 'leaderboard').find((tab) => tab.key === SETTINGS_TAB)?.search,
    ).toEqual({});
  });
});

describe('the command palette reaches what the sidebar promotes', () => {
  const modules = [
    {
      id: 'leveling',
      name: 'Leveling',
      category: 'engagement',
      fields: [{ path: 'enabled', label: 'Enabled' }],
      commands: [],
      enabled: true,
      dashboard: { icon: 'trending-up', sections: [] },
      status: null,
    },
  ];

  const index = paletteIndex(modules);

  test('a data view is findable by its own name', () => {
    const hit = paletteResults(index, 'leaderboard')[0];

    expect(hit?.label).toBe('Leaderboard');
    expect(hit?.view).toBe('leaderboard');
  });

  test('every area of an area’d module is findable', () => {
    for (const area of areasFor('leveling')) {
      const hit = paletteResults(index, area.title.toLowerCase())[0];

      expect(`${area.id}: ${hit?.area ?? 'nowhere'}`).toBe(`${area.id}: ${area.id}`);
    }
  });

  test('the module itself still leads its own name', () => {
    expect(paletteResults(index, 'leveling')[0]?.label).toBe('Leveling');
  });
});

describe('what a successful save is allowed to claim', () => {
  const summary = (name: string, code?: string) => ({
    name,
    status: code ? { disabledReason: { code } } : null,
  });

  test('a running module is the only one that says the change is live', () => {
    expect(savedLine('running', summary('Automod'), 'Fraim’s server')).toBe(
      'Saved. Changes are live in Fraim’s server.',
    );
  });

  test('a switched-off module says nothing changed yet', () => {
    expect(savedLine('off', summary('Automod'), 'Fraim’s server')).toContain('is switched off');
  });

  // The gap card directly above says "Not running". The confirmation used to say "live in" over
  // the top of it, because it branched on the switch rather than on whether the module runs.
  test('a module that is on but cannot run says so, and names why', () => {
    expect(savedLine('blocked', summary('Automod', 'missing_permission'), 'Fraim’s server')).toBe(
      'Saved, but Automod is not running: a permission is missing.',
    );

    expect(
      savedLine('degraded', summary('Backup', 'insufficient_entitlement'), 'Fraim’s server'),
    ).toBe('Saved, but Backup is not running: not on this plan.');
  });
});

/**
 * A module page waits on four fetches. Replacing the whole page with a spinner threw away the name,
 * the category and the blurb — all of which the parent route had already put in the cache — and
 * then jumped the header into place when the config landed.
 *
 * There is no one dynamic route to hold this any more: the pending state lives in moduleRoute, and
 * each of the 29 hand-written pages inherits it by spreading that spec.
 */
describe('the module page keeps its header while it loads', () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, '..', 'src', 'components', 'module', 'route.tsx'),
    'utf8',
  );

  test('the route renders a pending state of its own, not the bare router default', () => {
    expect(SOURCE).toContain('pendingComponent: () => <ModulePending');
  });

  // A page that built its route object by hand would opt out of the pending header without ever
  // saying so, and 29 chances to do that is 29 chances for the heading to jump on one module only.
  test('every module page takes that pending state from the shared spec', () => {
    for (const moduleId of MODULE_ROUTE_IDS) {
      expect(`${moduleId}: ${sourceOf(moduleId)}`).toContain(`...moduleRoute('${moduleId}'`);
    }
  });

  // Inlining the header into one of them is how the two drift, and the drift shows up as the
  // heading moving the instant the page finishes loading. One shared component is what stops it:
  // the pending state renders ModuleChrome, and so does every page, rather than its own header.
  test('the pending state and the loaded page render the same chrome', () => {
    expect(SOURCE.match(/<ModuleChrome\b/g)?.length).toBe(1);

    for (const moduleId of MODULE_ROUTE_IDS) {
      const source = sourceOf(moduleId);

      expect(`${moduleId}: ${source.match(/<ModuleChrome\b/g)?.length ?? 0}`).toBe(
        `${moduleId}: 1`,
      );
      expect(`${moduleId}: ${source}`).not.toContain('<ModuleHeader');
    }
  });

  test('the pending header reads the cached module list without suspending on it', () => {
    const pending = SOURCE.slice(
      SOURCE.indexOf('function ModulePending'),
      SOURCE.indexOf('function ModuleError'),
    );

    expect(pending).toContain('useQuery(modulesQuery(guildId))');

    // useSuspenseQuery would suspend the pending component itself, so the router would fall back to
    // exactly the headerless spinner this replaced.
    expect(pending).not.toContain('useSuspenseQuery');
  });

  // The cache is warm here in practice — the parent awaits the list before the shell renders — but
  // a miss must degrade to the spinner alone rather than throwing on an undefined summary.
  test('a cache miss falls back to the spinner instead of failing', () => {
    expect(SOURCE).toContain('{summary ? (');
  });
});
