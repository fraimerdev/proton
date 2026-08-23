import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CaseSearchResult,
  caseQuerySchema,
  type LeaderboardResult,
  leaderboardQuerySchema,
} from '@proton/core';
import { tagQuerySchema } from '@proton/module-tags/query';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { BROWSE_VIEWS } from '../src/components/shell/module-meta.ts';
import {
  type AnyViewEntry,
  activeView,
  MODULE_VIEWS,
  moduleSearchSchema,
  parseViewSearch,
  resolveView,
  SETTINGS_TAB,
  tabsFor,
  viewSearchUpdate,
  viewsFor,
} from '../src/components/views/registry.ts';

function viewOf(moduleId: string, id: string): AnyViewEntry {
  const entry = activeView(moduleId, id);
  if (!entry) throw new Error(`no '${id}' view is registered for module '${moduleId}'`);

  return entry;
}

const CASE_RESULT: CaseSearchResult = {
  cases: [
    {
      id: '018f6f4c-0000-7000-8000-000000000001',
      caseNumber: 12,
      type: 'ban',
      actorId: '100000000000000001',
      targetId: '200000000000000002',
      moderatorId: '100000000000000001',
      reason: 'raid',
      moduleId: 'moderation',
      expiresAt: null,
      revertedAt: null,
      revertedBy: null,
      dryRun: false,
      createdAt: '2026-02-01T12:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
};

const LEADERBOARD_RESULT: LeaderboardResult = {
  entries: [{ userId: '700000000000000001', xp: 4200, level: 7, rank: 1 }],
  total: 1,
  page: 1,
  pageSize: 25,
};

const TAG_RESULT = {
  tags: [
    {
      name: 'rules',
      content: 'Be kind to each other.',
      createdBy: '700000000000000002',
      updatedBy: null,
      uses: 42,
      createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const FIXTURES: Record<string, { search: unknown; data: unknown; shows: string }> = {
  'cases/cases': {
    search: caseQuerySchema.parse({}),
    data: CASE_RESULT,
    shows: 'data-case-number="12"',
  },
  'leveling/leaderboard': {
    search: leaderboardQuerySchema.parse({}),
    data: LEADERBOARD_RESULT,
    shows: '700000000000000001',
  },
  'tags/tags': {
    search: tagQuerySchema.parse({}),
    data: TAG_RESULT,
    shows: 'Be kind to each other.',
  },
};

function everyView(): Array<{ moduleId: string; entry: AnyViewEntry }> {
  return Object.entries(MODULE_VIEWS).flatMap(([moduleId, entries]) =>
    entries.map((entry) => ({ moduleId, entry })),
  );
}

describe('the module view registry', () => {
  test('the case browser and the leaderboard belong to the modules that own their data', () => {
    const declared = Object.fromEntries(
      Object.keys(MODULE_VIEWS).map((id) => [
        id,
        viewsFor(id).map((view) => [view.id, view.title]),
      ]),
    );

    expect(declared).toEqual({
      cases: [['cases', 'Cases']],
      leveling: [['leaderboard', 'Leaderboard']],
      tags: [['tags', 'Tags']],
    });
  });

  test('every view is registered lazily, so the table libraries stay off the landing page', () => {
    for (const { moduleId, entry } of everyView()) {
      expect(`${moduleId}/${entry.id}: ${typeof entry.View.preload}`).toBe(
        `${moduleId}/${entry.id}: function`,
      );
    }
  });

  test('every registered view resolves to a component, a search schema and a query', () => {
    for (const { moduleId, entry } of everyView()) {
      expect(`${moduleId}/${entry.id}: ${typeof entry.View} ${typeof entry.query}`).toBe(
        `${moduleId}/${entry.id}: function function`,
      );
      expect(entry.searchSchema).toBeInstanceOf(z.ZodType);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  test('every view keys its cache under the guild, its own id and the filters it was given', () => {
    for (const { entry } of everyView()) {
      const search = parseViewSearch(entry, {});

      expect(entry.query({ guildId: '900000000000000001', search }).queryKey).toEqual([
        'guild',
        '900000000000000001',
        'view',
        entry.id,
        search,
      ]);
    }
  });

  test('two guilds never share a view cache entry', () => {
    for (const { entry } of everyView()) {
      const search = parseViewSearch(entry, {});
      const first = entry.query({ guildId: '900000000000000001', search }).queryKey;
      const second = entry.query({ guildId: '900000000000000002', search }).queryKey;

      expect(first).not.toEqual(second);
    }
  });

  test('a module with settings but no data of its own registers no views', () => {
    expect(viewsFor('automod')).toEqual([]);
    expect(tabsFor(viewsFor('automod'), undefined)).toEqual([]);
    expect(activeView('automod', 'cases')).toBeUndefined();
  });

  test('a module id nobody registered — including an inherited one — yields an empty set', () => {
    expect(viewsFor('ticket')).toEqual([]);
    expect(viewsFor('constructor')).toEqual([]);
    expect(viewsFor('toString')).toEqual([]);
  });

  test('every view loads with an empty query, so a freshly opened tab is not a filter error', () => {
    for (const { moduleId, entry } of everyView()) {
      expect(`${moduleId}/${entry.id}: ${typeof parseViewSearch(entry, {})}`).toBe(
        `${moduleId}/${entry.id}: object`,
      );
    }
  });

  test('every registered view has a fixture here, so a new one cannot land unrendered', () => {
    expect(
      everyView()
        .map(({ moduleId, entry }) => `${moduleId}/${entry.id}`)
        .sort(),
    ).toEqual(Object.keys(FIXTURES).sort());
  });

  test('every registered view renders the data its loader hands back', async () => {
    for (const { moduleId, entry } of everyView()) {
      const fixture = FIXTURES[`${moduleId}/${entry.id}`];
      if (!fixture) throw new Error(`no fixture for ${moduleId}/${entry.id}`);

      // The registry holds these lazily so the landing page does not ship react-table; the module
      // loader preloads them for the same reason this test has to.
      await entry.View.preload?.();

      const html = renderToStaticMarkup(
        <entry.View search={fixture.search} data={fixture.data} onSearch={() => undefined} />,
      );

      expect(html).toContain('<table');
      expect(html).toContain(fixture.shows);
    }
  });
});

describe('which tab the address bar selects', () => {
  test('a module page with no view parameter shows its settings', () => {
    expect(resolveView('cases', undefined)).toBeUndefined();
    expect(tabsFor(viewsFor('cases'), undefined).find((tab) => tab.current)?.title).toBe(
      'Settings',
    );
  });

  test('the view parameter selects that view, so the tab is shareable', () => {
    expect(resolveView('cases', 'cases')?.title).toBe('Cases');
    expect(resolveView('leveling', 'leaderboard')?.title).toBe('Leaderboard');
  });

  test('a view another module owns is refused here rather than rendered as an empty settings page', () => {
    expect(() => resolveView('cases', 'leaderboard')).toThrow(/no 'leaderboard' tab/);
    expect(() => resolveView('cases', 'leaderboard')).toThrow(/it has 'cases'/);
  });

  test('a misspelled view parameter fails the way a bad filter does, not by showing settings', () => {
    expect(() => resolveView('cases', 'leaderbord')).toThrow(/no 'leaderbord' tab/);
    expect(() => resolveView('cases', 'tickets')).toThrow(
      /Remove the view parameter from the address bar/,
    );
    expect(() => resolveView('cases', 42)).toThrow(/no '42' tab/);
    expect(() => resolveView('cases', null)).toThrow(/no 'null' tab/);
  });

  test('a module that registers no views says so instead of listing an empty set', () => {
    expect(() => resolveView('automod', 'cases')).toThrow(/it has settings only/);
  });

  test('the tab strip leads with settings and then every view the module registers', () => {
    expect(tabsFor(viewsFor('cases'), 'cases')).toEqual([
      { key: SETTINGS_TAB, title: 'Settings', search: {}, current: false },
      { key: 'view:cases', title: 'Cases', search: { view: 'cases' }, current: true },
    ]);
  });
});

describe('a view may legally be called settings', () => {
  const SETTINGS_NAMED: AnyViewEntry = {
    id: SETTINGS_TAB,
    title: 'Settings history',
    searchSchema: z.object({}),
    query: () => ({ queryKey: ['settings-history'], queryFn: async () => ({}) }),
    View: () => null,
  };

  test('it reaches its own tab and leaves the settings form its own, sharing no id namespace', () => {
    expect(tabsFor([SETTINGS_NAMED], SETTINGS_TAB)).toEqual([
      { key: SETTINGS_TAB, title: 'Settings', search: {}, current: false },
      {
        key: 'view:settings',
        title: 'Settings history',
        search: { view: SETTINGS_TAB },
        current: true,
      },
    ]);
  });

  test('the settings form stays reachable by dropping the view parameter', () => {
    expect(tabsFor([SETTINGS_NAMED], undefined).map((tab) => [tab.title, tab.current])).toEqual([
      ['Settings', true],
      ['Settings history', false],
    ]);
  });

  test('exactly one tab is current, so no two links ever claim aria-current', () => {
    for (const view of [undefined, SETTINGS_TAB, 'nothing-registered', 42, null]) {
      expect(tabsFor([SETTINGS_NAMED], view).filter((tab) => tab.current)).toHaveLength(1);
    }
  });

  test('the two tabs keep distinct React keys', () => {
    const keys = tabsFor([SETTINGS_NAMED], undefined).map((tab) => tab.key);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the module route validates its search loosely so each view can re-parse it', () => {
  const routeValidator = zodValidator(moduleSearchSchema);

  const url = defaultStringifySearch({
    view: 'cases',
    type: 'ban',
    targetId: '200000000000000002',
    page: 3,
  });

  test('the route keeps the filters it does not itself understand', () => {
    expect(routeValidator.parse(defaultParseSearch(url))).toEqual({
      view: 'cases',
      type: 'ban',
      targetId: '200000000000000002',
      page: 3,
    });
  });

  test('a strict object at the route would strip them before the loader ever saw them', () => {
    expect(z.object({ view: z.string().optional() }).parse(defaultParseSearch(url))).toEqual({
      view: 'cases',
    });
  });

  test('the view re-parses its own slice and drops the tab parameter the API has no use for', () => {
    const search = parseViewSearch(viewOf('cases', 'cases'), defaultParseSearch(url));

    expect(search).toEqual(
      caseQuerySchema.parse({ type: 'ban', targetId: '200000000000000002', page: 3 }),
    );
    expect(search).not.toHaveProperty('view');
  });

  test('each view re-parses with its own schema, not with whichever ran last', () => {
    expect(parseViewSearch(viewOf('leveling', 'leaderboard'), { view: 'leaderboard' })).toEqual(
      leaderboardQuerySchema.parse({}),
    );
  });

  test('a module page with no query string at all reaches the loader as an empty search', () => {
    expect(routeValidator.parse(defaultParseSearch(''))).toEqual({});
  });

  test.each([
    ['a bare number', '?view=1'],
    ['a bare boolean', '?view=true'],
    ['a bare null', '?view=null'],
    ['the parameter twice, which parses as an array', '?view=cases&view=leaderboard'],
  ])(
    'the route hands resolveView %s untouched, so the tab that does not exist is named in a sentence',
    (_label, url) => {
      const search = routeValidator.parse(defaultParseSearch(url)) as { view?: unknown };

      expect(() => resolveView('cases', search.view)).toThrow(/tab —/);
      expect(() => resolveView('cases', search.view)).toThrow(
        /Remove the view parameter from the address bar/,
      );
    },
  );

  test('the route does not type-check view itself, which would answer with a raw Zod dump', () => {
    expect(() => routeValidator.parse(defaultParseSearch('?view=1'))).not.toThrow();
    expect(() =>
      zodValidator(z.looseObject({ view: z.string().optional() })).parse(
        defaultParseSearch('?view=1'),
      ),
    ).toThrow(/expected string/);
  });
});

describe('a filter a view refuses reaches the error component', () => {
  test('the message names the offending filter and the way back to an unfiltered list', () => {
    expect(() =>
      parseViewSearch(viewOf('cases', 'cases'), { view: 'cases', targetId: 'not-an-id' }),
    ).toThrow(/targetId: must be a Discord snowflake/);

    expect(() =>
      parseViewSearch(viewOf('cases', 'cases'), { view: 'cases', targetId: 'not-an-id' }),
    ).toThrow(/Remove the query string from the address bar/);
  });

  test('a rejected filter throws rather than quietly loading an unfiltered page', () => {
    expect(() => parseViewSearch(viewOf('leveling', 'leaderboard'), { page: 0 })).toThrow(
      /Leaderboard filters are not valid/,
    );
  });
});

const ROUTE = join(
  import.meta.dir,
  '..',
  'src',
  'routes',
  'dashboard',
  '$guildId',
  '$moduleId.tsx',
);

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('paging a view rewrites the address bar instead of stacking history', () => {
  test('the leaderboard pager replaces its entry, so Back leaves the page rather than walking it', () => {
    expect(viewSearchUpdate({ page: 4 }).replace).toBe(true);
  });

  test('a page change keeps the tab and the filters already in the URL', () => {
    const { search } = viewSearchUpdate({ page: 4 });

    expect(search({ view: 'cases', type: 'ban', page: 3 })).toEqual({
      view: 'cases',
      type: 'ban',
      page: 4,
    });
  });

  test('both views page through that one update, so cases and the leaderboard agree', () => {
    const route = flatten(readFileSync(ROUTE, 'utf8'));

    expect(route).toContain('onSearch={(patch) => void navigate(viewSearchUpdate(patch))}');
  });
});

describe('the module route loads a view only while its tab is open', () => {
  test('the loader asks the registry for the active view before it fetches anything', () => {
    const route = flatten(readFileSync(ROUTE, 'utf8'));

    expect(route).toContain('const entry = resolveView(params.moduleId, deps.view);');
    expect(route).toContain('queryClient.fetchQuery(entry.query(');
    expect(route).toContain('entry.View.preload?.()');
  });

  test('the loader resolves rather than looks up, so an unknown view reaches the error component', () => {
    const route = flatten(readFileSync(ROUTE, 'utf8'));

    expect(route).not.toContain('activeView(params.moduleId');
    expect(route).toContain('errorComponent: ModuleError');
  });
});

describe('the sidebar browse list mirrors the registry', () => {
  test('every browsable view is a real view on a real module, and none is missed', () => {
    const registry = Object.entries(MODULE_VIEWS)
      .flatMap(([moduleId, views]) => views.map((view) => `${moduleId}/${view.id}/${view.title}`))
      .sort();

    const sidebar = BROWSE_VIEWS.map(
      (entry) => `${entry.moduleId}/${entry.viewId}/${entry.title}`,
    ).sort();

    expect(sidebar).toEqual(registry);
  });
});

describe('a filter that navigates does not do it per keystroke', () => {
  const views = readFileSync(
    join(import.meta.dir, '..', 'src', 'components', 'views', 'views.tsx'),
    'utf8',
  );

  // Every commit rewrites the query string and re-runs the loader. A controlled input wired
  // straight to onSearch also cannot show a character until its own round trip returns, so fast
  // typing drops and reorders them.
  test('the two text-entry filters commit on a pause, not on change', () => {
    expect(views).toContain('function DebouncedFilter(');
    expect(views.split('<DebouncedFilter').length - 1).toBe(2);
  });

  // A date picker commits once per selection and an id filter is already uncontrolled with an
  // onBlur, so those stay plain. Only the boxes you type a character at a time into moved.
  test('no plain input you type into is left wired straight to a navigation', () => {
    const filters = views.slice(views.indexOf('className="filters"'));
    const offenders: string[] = [];

    for (const tag of filters.matchAll(/<input\b[\s\S]*?\/>/g)) {
      const type = /type="([a-z]+)"/.exec(tag[0])?.[1] ?? 'text';
      const navigates = /onChange=[\s\S]*?(onSearch|setFilters)\(/.test(tag[0]);

      if (navigates && type !== 'date') offenders.push(`${type} input navigates on change`);
    }

    expect(offenders).toEqual([]);
  });

  test('and the debounce still lets the address bar overrule it', () => {
    const component = views.slice(
      views.indexOf('function DebouncedFilter('),
      views.indexOf('const caseColumn'),
    );

    expect(component).toContain('setDraft(value);');
    expect(component).toContain('committed.current = value;');
  });
});
