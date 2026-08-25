import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { areasFor } from '../src/components/panels/areas.ts';
import { paletteIndex, paletteResults } from '../src/components/shell/app-shell.tsx';
import { SETTINGS_TAB, tabsFor, viewsFor } from '../src/components/views/registry.ts';
import { savedLine, settingsSurvives } from '../src/routes/dashboard/$guildId/$moduleId.tsx';

function at(pathname: string, search: Record<string, unknown> = {}) {
  return { pathname, search };
}

const AUTOMOD = '/dashboard/1/automod';
const TICKETS = '/dashboard/1/tickets';

describe('what counts as leaving the settings form', () => {
  test('a module with no areas keeps its form across a hash jump', () => {
    expect(settingsSurvives('tickets', at(TICKETS), at(TICKETS))).toBe(true);
  });

  test('opening another module leaves it', () => {
    expect(settingsSurvives('tickets', at(TICKETS), at(AUTOMOD))).toBe(false);
  });

  test('switching to a data view leaves it', () => {
    expect(
      settingsSurvives(
        'cases',
        at('/dashboard/1/cases'),
        at('/dashboard/1/cases', { view: 'cases' }),
      ),
    ).toBe(false);
  });

  test('moving between two areas keeps it, so nothing is confirmed that cannot be lost', () => {
    expect(
      settingsSurvives(
        'automod',
        at(AUTOMOD, { area: 'checks' }),
        at(AUTOMOD, { area: 'response' }),
      ),
    ).toBe(true);
  });

  /**
   * The hub replaces the whole settings subtree, so this move unmounts the form and drops every
   * unsaved edit in it. It used to pass the blocker untouched — same pathname, same view — and
   * discard the work with no confirmation at all.
   */
  test('leaving the last area for the hub does not keep it', () => {
    expect(settingsSurvives('automod', at(AUTOMOD, { area: 'checks' }), at(AUTOMOD))).toBe(false);
  });

  test('arriving at an area from the hub does not keep it either', () => {
    expect(settingsSurvives('automod', at(AUTOMOD), at(AUTOMOD, { area: 'checks' }))).toBe(false);
  });
});

describe('the settings tab round-trips', () => {
  test('with an area open it carries the area, so the current tab is not a way off the page', () => {
    const tabs = tabsFor(viewsFor('leveling'), undefined, 'rewards');
    const settings = tabs.find((tab) => tab.key === SETTINGS_TAB);

    expect(settings?.current).toBe(true);
    expect(settings?.search).toEqual({ area: 'rewards' });
  });

  test('with no area it stays a bare settings link', () => {
    expect(
      tabsFor(viewsFor('leveling'), 'leaderboard').find((tab) => tab.key === SETTINGS_TAB)?.search,
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
 */
describe('the module page keeps its header while it loads', () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId', '$moduleId.tsx'),
    'utf8',
  );

  test('the route renders a pending state of its own, not the bare router default', () => {
    expect(SOURCE).toContain('pendingComponent: ModulePending');
  });

  // Inlining the header into one of them is how the two drift, and the drift shows up as the
  // heading moving the instant the page finishes loading.
  test('the pending state and the loaded page render the same chrome', () => {
    expect(SOURCE.match(/<ModuleChrome\b/g)?.length).toBe(2);
  });

  test('the pending header reads the cached module list without suspending on it', () => {
    const pending = SOURCE.slice(
      SOURCE.indexOf('function ModulePending'),
      SOURCE.indexOf('function ModulePage'),
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
