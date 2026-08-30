import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BlockedMemberList,
  blockedMemberQuerySchema,
  type CaseSearchResult,
  caseQuerySchema,
  type LeaderboardResult,
  leaderboardQuerySchema,
} from '@proton/core';
import { tagQuerySchema } from '@proton/module-tags/query';
import { ticketQuerySchema } from '@proton/module-tickets/query';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { SETTINGS_TAB, tabsFor } from '../src/components/module/page.tsx';
import { MODULE_ROUTE_IDS } from '../src/components/module/paths.ts';
import {
  type ModuleView,
  parseViewSearch,
  resolveView,
  viewSearchUpdate,
} from '../src/components/module/views.ts';
import { BROWSE_VIEWS } from '../src/components/shell/module-meta.ts';
import {
  BlockedMembersView,
  CaseBrowserView,
  LeaderboardView,
  TagBrowserView,
  TicketBrowserView,
} from '../src/components/views/views.tsx';
import { queryKeys } from '../src/lib/query-keys.ts';

const SRC = join(import.meta.dir, '..', 'src');
const ROUTES = join(SRC, 'routes', 'dashboard', '$guildId');
const MODULE_ROUTE = join(SRC, 'components', 'module', 'route.tsx');

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sourceOf(moduleId: string): string {
  return readFileSync(join(ROUTES, `${moduleId}.tsx`), 'utf8');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * There is no MODULE_VIEWS any more: each of the four modules with data of its own declares a local
 * `VIEWS` in its route file. Read rather than imported — a route file reaches lib/queries, then the
 * server functions, then the database at module scope, so no test can import one — and the entries
 * are rebuilt below from the real schema and the real component the route names.
 */
const VIEWS_BLOCK = /const VIEWS/;

function viewsBlock(source: string): string | undefined {
  const start = source.search(VIEWS_BLOCK);
  if (start === -1) return undefined;

  const end = source.indexOf('\n];', start);
  return end === -1 ? undefined : source.slice(start, end + 3);
}

interface DeclaredView {
  moduleId: string;
  id: string;
  title: string;
  schema: string;
  component: string;
  keyId: string;
  lazy: boolean;
}

// Sliced on `satisfies ViewEntry<…>`, which is what type-checks each entry's schema against the
// result its query returns — an entry written without it lands in the previous slice, and the
// count check below is what turns that into a failure rather than a silently shorter registry.
function declaredIn(moduleId: string): DeclaredView[] {
  const block = viewsBlock(sourceOf(moduleId));
  if (block === undefined) return [];

  return block
    .split(/\}\s*satisfies ViewEntry/)
    .slice(0, -1)
    .map(flatten)
    .map((entry) => ({
      moduleId,
      id: /\bid: '([^']+)'/.exec(entry)?.[1] ?? '',
      title: /\btitle: '([^']+)'/.exec(entry)?.[1] ?? '',
      schema: /\bsearchSchema: ([A-Za-z0-9_]+),/.exec(entry)?.[1] ?? '',
      keyId: /queryKey: queryKeys\.view\(guildId, '([^']+)', search\)/.exec(entry)?.[1] ?? '',
      component:
        /View: lazyRouteComponent\(\s*\(\) => import\('[^']+'\), '([A-Za-z0-9_]+)',?\s*\)/.exec(
          entry,
        )?.[1] ?? '',
      lazy: /View: lazyRouteComponent\(/.test(entry),
    }));
}

const DECLARED: ReadonlyMap<string, readonly DeclaredView[]> = new Map(
  MODULE_ROUTE_IDS.map((moduleId) => [moduleId, declaredIn(moduleId)] as const).filter(
    ([, views]) => views.length > 0,
  ),
);

function allDeclared(): DeclaredView[] {
  return [...DECLARED.values()].flat();
}

const SCHEMAS: Record<string, z.ZodType> = {
  blockedMemberQuerySchema,
  caseQuerySchema,
  leaderboardQuerySchema,
  tagQuerySchema,
  ticketQuerySchema,
};

const COMPONENTS: Record<string, ModuleView['View']> = {
  BlockedMembersView,
  CaseBrowserView,
  LeaderboardView,
  TagBrowserView,
  TicketBrowserView,
};

function entryOf(declared: DeclaredView): ModuleView {
  const searchSchema = SCHEMAS[declared.schema];
  const View = COMPONENTS[declared.component];

  if (!searchSchema || !View)
    throw new Error(
      `${declared.moduleId}/${declared.id} names '${declared.schema}' and '${declared.component}', ` +
        'which this file has no entry for — add one rather than letting the view go unchecked',
    );

  return {
    id: declared.id,
    title: declared.title,
    searchSchema,
    query: ({ guildId, search }) => ({
      queryKey: queryKeys.view(guildId, declared.keyId, search),
      queryFn: async () => undefined,
    }),
    View,
  };
}

const built = new Map<string, readonly ModuleView[]>();

function viewsOf(moduleId: string): readonly ModuleView[] {
  const held = built.get(moduleId);
  if (held) return held;

  const made = (DECLARED.get(moduleId) ?? []).map(entryOf);
  built.set(moduleId, made);

  return made;
}

function viewOf(moduleId: string, id: string): ModuleView {
  const entry = viewsOf(moduleId).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no '${id}' view is declared by the '${moduleId}' route`);

  return entry;
}

function everyView(): Array<{ moduleId: string; entry: ModuleView }> {
  return [...DECLARED.keys()].flatMap((moduleId) =>
    viewsOf(moduleId).map((entry) => ({ moduleId, entry })),
  );
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

const TICKET_RESULT = {
  tickets: [
    {
      id: '018f6f4c-0000-7000-8000-000000000009',
      number: 12,
      typeId: 'billing',
      panelId: 'support',
      channelId: '300000000000000003',
      status: 'closed' as const,
      priority: 'urgent' as const,
      subject: 'Card declined on renewal',
      openerId: '700000000000000003',
      ownerId: '700000000000000003',
      claimedById: '700000000000000004',
      assignedToId: null,
      closedBy: '700000000000000004',
      closeReason: 'resolved',
      messageCount: 8,
      transcriptUrl: null,
      openedAt: '2026-08-01T09:15:00.000Z',
      lastActivityAt: '2026-08-01T10:02:00.000Z',
      closedAt: '2026-08-01T10:05:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const BLOCKED_RESULT: BlockedMemberList = {
  rows: [
    {
      id: '018f6f4c-0000-7000-8000-000000000009',
      guildId: '900000000000000001',
      userId: '400000000000000007',
      moduleId: 'honeypot',
      blockedBy: 'proton:honeypot',
      reason: 'Posted in a honeypot channel.',
      caseId: null,
      evidence: null,
      createdAt: '2026-02-01T12:00:00.000Z',
      liftedAt: null,
      liftedBy: null,
      liftReason: null,
    },
  ],
  total: 1,
};

const FIXTURES: Record<string, { search: unknown; data: unknown; shows: string }> = {
  'moderation/blocked': {
    search: blockedMemberQuerySchema.parse({}),
    data: BLOCKED_RESULT,
    shows: '400000000000000007',
  },
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
  'tickets/tickets': {
    search: ticketQuerySchema.parse({}),
    data: TICKET_RESULT,
    shows: 'data-ticket-number="12"',
  },
};

describe('the views the module routes declare', () => {
  test('the case browser and the leaderboard belong to the modules that own their data', () => {
    const declared = Object.fromEntries(
      [...DECLARED.keys()].map((id) => [id, viewsOf(id).map((view) => [view.id, view.title])]),
    );

    expect(declared).toEqual({
      cases: [['cases', 'Cases']],
      moderation: [['blocked', 'Blocked members']],
      leveling: [['leaderboard', 'Leaderboard']],
      tags: [['tags', 'Tags']],
      tickets: [['tickets', 'Tickets']],
    });
  });

  // If the slicing stops matching the route files, every check below reads an empty registry and
  // passes having asserted nothing at all.
  test('the entries really parsed out of the route source', () => {
    expect(DECLARED.size).toBeGreaterThan(0);

    for (const [moduleId, views] of DECLARED) {
      const block = viewsBlock(sourceOf(moduleId)) ?? '';

      expect(`${moduleId}: ${views.length}`).toBe(
        `${moduleId}: ${[...block.matchAll(/\bid: '/g)].length}`,
      );
    }
  });

  test('every declared view resolves to a component, a search schema and a query', () => {
    for (const { moduleId, entry } of everyView()) {
      expect(`${moduleId}/${entry.id}: ${typeof entry.View} ${typeof entry.query}`).toBe(
        `${moduleId}/${entry.id}: function function`,
      );
      expect(entry.searchSchema).toBeInstanceOf(z.ZodType);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  test('every view is registered lazily, so the table libraries stay off every other page', () => {
    for (const declared of allDeclared()) {
      expect(`${declared.moduleId}/${declared.id}: ${declared.lazy}`).toBe(
        `${declared.moduleId}/${declared.id}: true`,
      );
    }
  });

  // The laziness only buys anything while the dynamic import is the sole way in: one `from` on
  // views.tsx anywhere — the sidebar, the palette, another route — ships react-table and
  // react-virtual to every page that reaches it, including the landing page.
  test('nothing reaches the browse tables except through that dynamic import', () => {
    const files = sourceFiles(SRC);

    // A walk that reaches nothing reports no offenders, which reads exactly like a clean scan.
    expect(files.map((file) => file.replace(SRC, 'src'))).toContain(
      join('src', 'components', 'views', 'views.tsx'),
    );

    const offenders = files
      .filter((file) => /from '[^']*views\/views\.tsx'/.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(SRC, 'src'));

    expect(offenders).toEqual([]);
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

  // The entries above are rebuilt here, so without this the key being checked is this file's idea
  // of one rather than the route's.
  test('and that key is the route file’s own, not this file’s idea of one', () => {
    for (const declared of allDeclared()) {
      expect(`${declared.moduleId}/${declared.id} keyed on: ${declared.keyId}`).toBe(
        `${declared.moduleId}/${declared.id} keyed on: ${declared.id}`,
      );
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

  test('a module with settings but no data of its own declares no views', () => {
    expect(DECLARED.has('automod')).toBe(false);
    expect(viewsOf('automod')).toEqual([]);
    expect(tabsFor(viewsOf('automod'), undefined)).toEqual([]);
    expect(resolveView('automod', viewsOf('automod'), undefined)).toBeUndefined();
  });

  test('every view loads with an empty query, so a freshly opened tab is not a filter error', () => {
    for (const { moduleId, entry } of everyView()) {
      expect(`${moduleId}/${entry.id}: ${typeof parseViewSearch(entry, {})}`).toBe(
        `${moduleId}/${entry.id}: object`,
      );
    }
  });

  test('every declared view has a fixture here, so a new one cannot land unrendered', () => {
    expect(
      everyView()
        .map(({ moduleId, entry }) => `${moduleId}/${entry.id}`)
        .sort(),
    ).toEqual(Object.keys(FIXTURES).sort());
  });

  test('every declared view renders the data its loader hands back', () => {
    for (const { moduleId, entry } of everyView()) {
      const fixture = FIXTURES[`${moduleId}/${entry.id}`];
      if (!fixture) throw new Error(`no fixture for ${moduleId}/${entry.id}`);

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
    expect(resolveView('cases', viewsOf('cases'), undefined)).toBeUndefined();
    expect(tabsFor(viewsOf('cases'), undefined).find((tab) => tab.current)?.title).toBe('Settings');
  });

  test('the view parameter selects that view, so the tab is shareable', () => {
    expect(resolveView('cases', viewsOf('cases'), 'cases')?.title).toBe('Cases');
    expect(resolveView('leveling', viewsOf('leveling'), 'leaderboard')?.title).toBe('Leaderboard');
  });

  test('a view another module owns is refused here rather than rendered as an empty settings page', () => {
    expect(() => resolveView('cases', viewsOf('cases'), 'leaderboard')).toThrow(
      /no 'leaderboard' tab/,
    );
    expect(() => resolveView('cases', viewsOf('cases'), 'leaderboard')).toThrow(/it has 'cases'/);
  });

  test('a misspelled view parameter fails the way a bad filter does, not by showing settings', () => {
    expect(() => resolveView('cases', viewsOf('cases'), 'leaderbord')).toThrow(
      /no 'leaderbord' tab/,
    );
    expect(() => resolveView('cases', viewsOf('cases'), 'tickets')).toThrow(
      /Remove the view parameter from the address bar/,
    );
    expect(() => resolveView('cases', viewsOf('cases'), 42)).toThrow(/no '42' tab/);
    expect(() => resolveView('cases', viewsOf('cases'), null)).toThrow(/no 'null' tab/);
  });

  test('a module that declares no views says so instead of listing an empty set', () => {
    expect(() => resolveView('automod', viewsOf('automod'), 'cases')).toThrow(
      /it has settings only/,
    );
  });

  test('the tab strip leads with settings and then every view the module declares', () => {
    expect(tabsFor(viewsOf('cases'), 'cases')).toEqual([
      { key: SETTINGS_TAB, title: 'Settings', search: {}, current: false },
      { key: 'view:cases', title: 'Cases', search: { view: 'cases' }, current: true },
    ]);
  });
});

describe('a view may legally be called settings', () => {
  const SETTINGS_NAMED: ModuleView = {
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
  /**
   * A copy, not the import: moduleSearchSchema lives in components/module/route.tsx, which reaches
   * lib/queries and through it the database at module scope. The declaration is pinned below, so a
   * change to the real one fails here rather than leaving this block exercising a fossil.
   */
  const moduleSearchSchema = z.looseObject({
    view: z.unknown().optional(),
    area: z.unknown().optional(),
  });

  const routeValidator = zodValidator(moduleSearchSchema);

  const url = defaultStringifySearch({
    view: 'cases',
    type: 'ban',
    targetId: '200000000000000002',
    page: 3,
  });

  test('the route declares the schema this block exercises', () => {
    expect(flatten(readFileSync(MODULE_ROUTE, 'utf8'))).toContain(
      'export const moduleSearchSchema = z.looseObject({ view: z.unknown().optional(), ' +
        'area: z.unknown().optional(), });',
    );
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

      expect(() => resolveView('cases', viewsOf('cases'), search.view)).toThrow(/tab —/);
      expect(() => resolveView('cases', viewsOf('cases'), search.view)).toThrow(
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

  // One update shared by four hand-written route files now, rather than one dynamic route: the
  // pager and the filters of every browse tab have to agree on replace, or Back walks the reader
  // through each page they turned on one module and not on another.
  test('every view pages through that one update, so cases and the leaderboard agree', () => {
    for (const moduleId of DECLARED.keys()) {
      expect(`${moduleId}: ${flatten(sourceOf(moduleId))}`).toContain(
        'onSearch={(patch) => void navigate(viewSearchUpdate(patch))}',
      );
    }
  });
});

describe('the module route loads a view only while its tab is open', () => {
  const route = flatten(readFileSync(MODULE_ROUTE, 'utf8'));
  const loader = route.slice(route.indexOf('loader: async'), route.indexOf('head: ('));

  test('the loader resolves the active view before it fetches anything', () => {
    expect(loader).toContain('const entry = resolveView(moduleId, views, deps.view);');
    expect(loader).toContain('queryClient.fetchQuery(entry.query(');
    expect(loader).toContain('entry.View.preload?.()');
  });

  test('the loader resolves rather than looks up, so an unknown view reaches the error component', () => {
    expect(loader).not.toContain('views.find(');
    expect(route).toContain('errorComponent:');
    expect(route).toContain('<ModuleError error={error} />');
  });

  // The settings form's config, channel and role fetches are an api call and two Discord calls
  // whose answers a browse tab throws away — and the view's own query is the one thing a settings
  // tab has no use for. Fetching both is what makes either tab pay for the other.
  test('the two tabs fetch their own half and not the other’s', () => {
    expect(loader).toContain('entry ? Promise.all([ queryClient.fetchQuery(entry.query(');
    expect(loader).toContain(': Promise.all([ queryClient.fetchQuery(moduleConfigQuery(');
  });

  // The loader resolves from the list the route was built with; the page picks from the same const.
  // Two lists would render the settings form under a tab whose data the loader had just fetched.
  test('each page dispatches on the same views its route was built with', () => {
    for (const moduleId of DECLARED.keys()) {
      const source = flatten(sourceOf(moduleId));

      expect(`${moduleId}: ${source}`).toContain(`moduleRoute('${moduleId}', {`);
      expect(`${moduleId}: ${source}`).toContain('views: VIEWS');
      expect(`${moduleId}: ${source}`).toContain('VIEWS.find(');
      expect(`${moduleId}: ${source}`).toContain('tabsFor(VIEWS, search.view');
    }
  });
});

describe('the sidebar browse list mirrors what the routes declare', () => {
  test('every browsable view is a real view on a real module, and none is missed', () => {
    const declared = allDeclared()
      .map((view) => `${view.moduleId}/${view.id}/${view.title}`)
      .sort();

    const sidebar = BROWSE_VIEWS.map(
      (entry) => `${entry.moduleId}/${entry.viewId}/${entry.title}`,
    ).sort();

    expect(sidebar).toEqual(declared);
  });
});

describe('a filter that navigates does not do it per keystroke', () => {
  const views = readFileSync(join(SRC, 'components', 'views', 'views.tsx'), 'utf8');

  // Every commit rewrites the query string and re-runs the loader. A controlled input wired
  // straight to onSearch also cannot show a character until its own round trip returns, so fast
  // typing drops and reorders them.
  test('the three text-entry filters commit on a pause, not on change', () => {
    expect(views).toContain('function DebouncedFilter(');
    expect(views.split('<DebouncedFilter').length - 1).toBe(5);
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
