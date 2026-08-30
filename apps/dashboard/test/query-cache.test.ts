import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashKey } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { MODULE_ROUTE_IDS } from '../src/components/module/paths.ts';
import { makeQueryClient } from '../src/lib/query-client.ts';
import { queryKeys, STALE } from '../src/lib/query-keys.ts';

const SRC = join(import.meta.dir, '..', 'src');
const ROUTES = join(SRC, 'routes', 'dashboard');
const PAGES = join(ROUTES, '$guildId');

function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8');
}

function route(...parts: string[]): string {
  return readFileSync(join(ROUTES, ...parts), 'utf8');
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

// The 29 module pages replaced the one dynamic $moduleId route, so every invariant this file used
// to assert about that single file now has to hold 29 times over. Read once, keyed by module id.
const pages = new Map(
  MODULE_ROUTE_IDS.map((id) => [id, readFileSync(join(PAGES, `${id}.tsx`), 'utf8')]),
);

const GUILD = '900000000000000001';
const OTHER = '900000000000000002';

describe('one query client per request', () => {
  test('the factory hands back a fresh client every call', () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });

  test('a cache write on one client is invisible to the next', () => {
    const first = makeQueryClient();
    first.setQueryData(queryKeys.session(), { guilds: [], user: null });

    expect(makeQueryClient().getQueryData(queryKeys.session())).toBeUndefined();
  });

  // Hoisting the client to module scope would render, and pass, exactly the same in development:
  // it only leaks one admin's guild list into another's SSR response under concurrent requests.
  test('the router builds its client inside getRouter, not at module scope', () => {
    const router = readFileSync(join(SRC, 'router.tsx'), 'utf8');

    expect(router).toContain(
      'export function getRouter() {\n  const queryClient = makeQueryClient();',
    );
    expect(router).not.toMatch(/^const queryClient = makeQueryClient\(\);/m);
  });
});

describe('retry policy', () => {
  const retry = makeQueryClient().getDefaultOptions().queries?.retry;

  function retries(error: unknown, failures = 0): boolean {
    if (typeof retry !== 'function') throw new Error('queries.retry is not a predicate');

    return retry(failures, error as Error);
  }

  test('a redirect thrown out of a loader query is performed, not retried', () => {
    expect(retries(redirect({ to: '/dashboard' }))).toBe(false);
  });

  test('a genuine failure is retried once and then given up on', () => {
    expect(retries(new Error('api returned 503'), 0)).toBe(true);
    expect(retries(new Error('api returned 503'), 1)).toBe(false);
  });

  test('an access refusal is not retried, because the retry re-runs the Discord check', () => {
    for (const message of [
      'forbidden',
      'not signed in',
      'you do not administer that server',
      'you lack the required permission in that server',
    ]) {
      expect(`${message}: ${retries(new Error(message))}`).toBe(`${message}: false`);
    }
  });

  test('a ForbiddenError that kept its name but lost its message is still not retried', () => {
    const error = new Error('the server said no');
    error.name = 'ForbiddenError';

    expect(retries(error)).toBe(false);
  });
});

describe('query keys', () => {
  test('every guild-scoped key nests under the guild, so one invalidate clears the lot', () => {
    const guild = queryKeys.guild(GUILD);

    for (const key of [
      queryKeys.modules(GUILD),
      queryKeys.moduleConfig(GUILD, 'automod'),
      queryKeys.channels(GUILD),
      queryKeys.roles(GUILD),
      queryKeys.view(GUILD, 'cases', {}),
    ]) {
      expect(key.slice(0, guild.length)).toEqual([...guild]);
    }
  });

  test('the session key sits outside the guild namespace, because it outlives the guild', () => {
    expect(queryKeys.session()[0]).not.toBe(queryKeys.guild(GUILD)[0]);
  });

  test('two guilds never share an entry', () => {
    expect(hashKey(queryKeys.modules(GUILD))).not.toBe(hashKey(queryKeys.modules(OTHER)));
    expect(hashKey(queryKeys.channels(GUILD))).not.toBe(hashKey(queryKeys.channels(OTHER)));
  });

  test('two modules in one guild never share an entry', () => {
    expect(hashKey(queryKeys.moduleConfig(GUILD, 'automod'))).not.toBe(
      hashKey(queryKeys.moduleConfig(GUILD, 'cases')),
    );
  });

  test('the same filters in a different order are the same cached page', () => {
    expect(hashKey(queryKeys.view(GUILD, 'cases', { page: 2, sort: 'createdAt' }))).toBe(
      hashKey(queryKeys.view(GUILD, 'cases', { sort: 'createdAt', page: 2 })),
    );
  });

  test('a different page is a different entry', () => {
    expect(hashKey(queryKeys.view(GUILD, 'cases', { page: 2 }))).not.toBe(
      hashKey(queryKeys.view(GUILD, 'cases', { page: 3 })),
    );
  });

  test('the overview tile and the case browser share the cases namespace', () => {
    const tile = queryKeys.view(GUILD, 'cases', { pageSize: 1 });

    expect(tile.slice(0, 4)).toEqual(['guild', GUILD, 'view', 'cases']);
  });
});

describe('staleness', () => {
  test('the channel and role lists outlive the module list, because Discord changes them less', () => {
    expect(STALE.guildShape).toBeGreaterThan(STALE.modules);
  });

  test('nothing is fetched fresh on every navigation', () => {
    for (const [name, ms] of Object.entries(STALE)) {
      expect(`${name}: ${ms > 0}`).toBe(`${name}: true`);
    }
  });
});

// Every assertion below is a scan over files picked by name, so a rename would quietly leave it
// asserting over nothing. This is the guard: the ids and the directory have to agree first.
describe('the module pages this file asserts over', () => {
  test('every routed module id has a page, and every page is a routed module id', () => {
    const onDisk = readdirSync(PAGES)
      .filter((name) => name.endsWith('.tsx') && name !== 'index.tsx')
      .map((name) => name.slice(0, -'.tsx'.length))
      .sort();

    expect(onDisk).toEqual([...MODULE_ROUTE_IDS].sort());
  });

  // A floor, not an equality: a thirtieth module is a normal Tuesday, but a collapse back towards
  // one page would leave every scan below asserting almost nothing and still green.
  test('there are 29 of them, not the one dynamic route they replaced', () => {
    expect(pages.size).toBeGreaterThanOrEqual(29);
  });

  // The id is written three times per file, and the middle one is the cache key: a page whose
  // useModuleForm says 'welcome' under a route that says 'welcomes' reads, edits and saves another
  // module's config entry. This is what replaced the dynamic route's key={moduleId} — the component
  // is no longer shared across module ids, so nothing can carry the previous module's edits in.
  test('a page, its route path, its loader and its form all name the same module', () => {
    for (const [id, source] of pages) {
      expect(`${id}: route path`).toBe(
        source.includes(`createFileRoute('/dashboard/$guildId/${id}')`)
          ? `${id}: route path`
          : `${id}: missing createFileRoute('/dashboard/$guildId/${id}')`,
      );

      const named = [
        ...source.matchAll(/moduleRoute\('([^']+)'/g),
        ...source.matchAll(/useModuleForm\(guildId, '([^']+)'/g),
      ].map((match) => match[1]);

      expect(`${id}: ${named.join(',')}`).toBe(`${id}: ${id},${id}`);
    }
  });

  // The dynamic route re-seeded four useStates by hand when :moduleId changed. useModuleForm holds
  // edited paths instead, and its only re-seed is the one below.
  test('no page re-seeds its form state by hand', () => {
    for (const [id, source] of pages) {
      expect(`${id}: ${source.includes('seededFor')}`).toBe(`${id}: false`);
    }
  });
});

describe('loaders go through the cache', () => {
  // Every loader in the app: the guild picker, the guild shell, the module list, the verify link,
  // and the one moduleRoute spreads into all 29 module pages.
  const LOADERS: readonly [string, string][] = [
    ['dashboard/index.tsx', route('index.tsx')],
    ['dashboard/$guildId.tsx', route('$guildId.tsx')],
    ['dashboard/$guildId/index.tsx', route('$guildId', 'index.tsx')],
    ['components/module/route.tsx', read('components', 'module', 'route.tsx')],
    ['verify/$token.tsx', read('routes', 'verify', '$token.tsx')],
  ];

  // The loader object ends where the route's other options begin. `component:` is lowercase on
  // purpose — it must not match pendingComponent: or errorComponent:.
  function loaderBody(source: string): string {
    const from = source.indexOf('loader:');
    if (from < 0) throw new Error('no loader in this route');

    const ends = ['head:', 'component:']
      .map((marker) => source.indexOf(marker, from))
      .filter((index) => index > from);

    return code(source.slice(from, Math.min(...ends)));
  }

  test('no route loader calls a server function directly', () => {
    for (const [name, source] of LOADERS) {
      const body = loaderBody(source);

      // fetchQuery, not ensureQueryData: ensureQueryData resolves from the cache at any age and
      // revalidates through prefetchQuery, whose rejection is swallowed — so a loader built on
      // it can neither await fresh data nor see the refusal it is supposed to redirect on.
      expect(`${name}: ${body.includes('fetchQuery(')}`).toBe(`${name}: true`);
      expect(`${name}: ${body.includes('ensureQueryData')}`).toBe(`${name}: false`);
      expect(
        `${name}: ${/\b(listGuilds|listModules|getModuleConfig|getGuild\w+)\(/.test(body)}`,
      ).toBe(`${name}: false`);
    }
  });

  // All 29 spread one loader out of moduleRoute. The split between a browse tab and the settings
  // form lives in that loader and nowhere else, so a page that grew its own would fetch around it.
  test('no module page declares a loader of its own', () => {
    for (const [id, source] of pages) {
      expect(`${id}: ${source.includes('loader:')}`).toBe(`${id}: false`);
      expect(`${id}: ${source.includes('...moduleRoute(')}`).toBe(`${id}: true`);
    }
  });

  test('and the shell fetches what every page under it reads', () => {
    expect(route('$guildId.tsx')).toContain('fetchQuery(modulesQuery(params.guildId))');
    expect(route('$guildId.tsx')).toContain('fetchQuery(sessionQuery())');
  });

  // The switch is in the sidebar and in the module header, both of which the layout owns, so a page
  // must never grow its own copy of the toggle: two optimistic writers on one cache entry cannot
  // agree about which value settled last.
  test('only the guild layout mutates the module switch', () => {
    for (const [id, source] of [...pages, ['index.tsx', route('$guildId', 'index.tsx')] as const]) {
      expect(`${id}: ${source.includes('useMutation')}`).toBe(`${id}: false`);
      expect(`${id}: ${source.includes('updateModuleConfig')}`).toBe(`${id}: false`);
    }
  });

  test('and the page that renders switches reaches the layout for one', () => {
    expect(route('$guildId', 'index.tsx')).toContain('useToggleModule()');
  });

  // A save writes the fresh config into the cache entry the page already reads. Reloading the route
  // to achieve the same thing re-runs every fetch in the loader for a form the mutation just
  // answered — and on a module with areas it also throws away the open area's scroll position.
  test('nothing refetches the whole route to save one form', () => {
    const scanned = [
      ...pages,
      ['$guildId/index.tsx', route('$guildId', 'index.tsx')] as const,
      ['$guildId.tsx', route('$guildId.tsx')] as const,
      ['module/form.ts', read('components', 'module', 'form.ts')] as const,
      ['module/page.tsx', read('components', 'module', 'page.tsx')] as const,
      ['module/route.tsx', read('components', 'module', 'route.tsx')] as const,
    ];

    for (const [id, source] of scanned) {
      expect(`${id}: ${source.includes('router.invalidate(')}`).toBe(`${id}: false`);
    }
  });
});

describe('a view tab does not pay for the settings form', () => {
  const module = read('components', 'module', 'route.tsx');

  const SETTINGS_ONLY = ['moduleConfigQuery', 'channelsQuery', 'rolesQuery'];

  // The pages that carry browse tabs. Pinned, because every test below scans exactly these and an
  // empty list would pass all of them.
  const BROWSABLE = [...pages].filter(([, source]) => source.includes('views: VIEWS'));

  function loader(): string {
    return code(module.slice(module.indexOf('loader:'), module.indexOf('head: (')));
  }

  test('the five pages with browse tabs are the five this asserts over', () => {
    expect(BROWSABLE.map(([id]) => id)).toEqual([
      'cases',
      'leveling',
      'moderation',
      'tags',
      'tickets',
    ]);
  });

  test('the loader branches on the active view before it fetches anything', () => {
    const body = loader();

    expect(body).toContain('const entry = resolveView(moduleId, views, deps.view);');
    expect(body.indexOf('resolveView')).toBeLessThan(body.indexOf('fetchQuery'));

    // Same reason, for the other thing that can be wrong in the address bar: a bad ?area= has to
    // reach the error component with its sentence rather than render an empty settings page.
    expect(body.indexOf('resolveArea')).toBeLessThan(body.indexOf('fetchQuery'));
  });

  test('opening a view tab asks for the view and the module list, nothing else', () => {
    const body = loader();
    const branch = body.slice(body.indexOf('entry'), body.lastIndexOf(': Promise.all(['));

    for (const name of SETTINGS_ONLY) {
      expect(`${name} in the view branch: ${branch.includes(name)}`).toBe(
        `${name} in the view branch: false`,
      );
    }

    expect(branch).toContain('entry.query(');
  });

  // Not a settings query in sight: the pending component renders from the module list the parent
  // layout already awaited, so a browse tab's spinner does not fetch a config it will never show.
  test('the pending header reads only what the parent already fetched', () => {
    const pending = module.slice(module.indexOf('function ModulePending('));

    for (const name of SETTINGS_ONLY) {
      expect(`${name} in ModulePending: ${pending.includes(name)}`).toBe(
        `${name} in ModulePending: false`,
      );
    }

    expect(pending).toContain('modulesQuery(guildId)');
  });

  // useModuleForm suspends on the config, the channel list and the role list — the three fetches
  // the loader skips while a view tab is open. Calling it in the component that renders both tabs
  // would suspend the browse table on data nothing asked for.
  test('the settings form is mounted in its own component, not in the page shell', () => {
    for (const [id, source] of BROWSABLE) {
      const name = /\n {2}component: (\w+),/.exec(source)?.[1];
      expect(`${id}: ${name !== undefined}`).toBe(`${id}: true`);

      const from = source.slice(source.indexOf(`function ${name}(`));
      const shell = from.slice(0, from.indexOf('\n}\n') + 2);

      // Sliced to the page component's own closing brace rather than to the next component,
      // because the components between them are the ones the form is meant to be mounted in.
      expect(`${id}: sliced`).toBe(
        shell.length < from.length ? `${id}: sliced` : `${id}: whole file`,
      );

      expect(`${id}: ${shell.includes('useModuleForm(')}`).toBe(`${id}: false`);
      expect(source).toContain('useModuleForm(guildId');
    }
  });
});

describe('what a mutation leaves behind', () => {
  const shell = route('$guildId.tsx');
  const form = read('components', 'module', 'form.ts');

  // One useMutation backs every switch, and its observer only reports the newest call — so a slow
  // toggle that fails after a later one succeeded would flip back with no banner naming why.
  test('a toggle failure is recorded by the mutation that failed, not by the shared observer', () => {
    const body = code(shell);

    expect(body).toContain('setFailure(');
    expect(body).not.toContain('toggle.error');
    expect(body).not.toContain('toggle.variables');
  });

  test('every toggle clears the previous failure as it starts, so the banner cannot outlive it', () => {
    const onMutate = shell.slice(shell.indexOf('onMutate:'), shell.indexOf('onError:'));

    expect(onMutate).toContain('setFailure(null)');
  });

  const onSuccess = form.slice(form.indexOf('onSuccess:'), form.indexOf('\n  });'));

  // The API normalises some configs on the way in, so the submitted values are not necessarily
  // what was stored. Seeding the baseline from them hides the difference behind a clean form.
  test('a save re-seeds the form from what the server stored, not from what was sent', () => {
    expect(onSuccess).toContain('onSuccess: (result) =>');
    expect(onSuccess).toContain('result.after');

    // react-query hands the submitted config to onSuccess as its second argument. Taking it is
    // the whole of the bug: nothing else here can reach what was sent.
    expect(onSuccess).not.toContain('variables');
  });

  // Into the entry the page reads, addressed through the same factory the read went through: a
  // hand-written key here writes a second entry and the form re-renders from the stale first one.
  test('and it writes them into the entry the page is already reading', () => {
    expect(onSuccess).toContain(
      'queryClient.setQueryData(moduleConfigQuery(guildId, moduleId).queryKey, result.after);',
    );
  });

  // A config change can switch a module from running to blocked — the header, the sidebar row and
  // the saved line all read that off the module list, which the write did not touch.
  test('a save invalidates the module list, because saving can change whether it runs', () => {
    expect(onSuccess).toContain('invalidateQueries({ queryKey: queryKeys.modules(guildId) })');
  });

  // The edits map is the whole of the form's state, so dropping it is the re-seed: the next read
  // falls through to the config that arrived underneath.
  test('an untouched form follows the config when it changes underneath', () => {
    expect(form).toContain('if (!dirty) setEdits({});');
  });
});

describe('what a tab left open still notices', () => {
  const queries = read('lib', 'queries.ts');

  function factories(source: string): Map<string, string> {
    const found = new Map<string, string>();

    for (const chunk of source.split('export function ').slice(1)) {
      const name = chunk.slice(0, chunk.indexOf('('));
      if (!name.endsWith('Query')) continue;

      found.set(name, chunk.slice(0, chunk.indexOf('});')));
    }

    return found;
  }

  // Proton's own guild row moves only on a join or a tier change; everything else here is owned by
  // Discord or by another admin, and a config dashboard that never notices is worse than a chatty
  // one.
  const OPTED_OUT = ['guildQuery'];

  test('the factories this asserts over really are all of them', () => {
    expect([...factories(queries).keys()].sort()).toEqual([
      'channelsQuery',
      'guildQuery',
      'moduleConfigQuery',
      'modulesQuery',
      'rolesQuery',
      'sessionQuery',
    ]);
  });

  test('every query whose truth lives outside the tab refetches when it regains focus', () => {
    for (const [name, body] of factories(queries)) {
      const wanted = !OPTED_OUT.includes(name);

      expect(`${name}: ${body.includes('...LIVE')}`).toBe(`${name}: ${wanted}`);
    }
  });

  // The browse queries moved out of one registry and into the four pages that own them, so this
  // counts per page instead: a view declared without ...LIVE shows a case list that never notices
  // the moderator sitting next to you closing one.
  test('and so does every browsable view', () => {
    let browse = 0;

    for (const [id, source] of pages) {
      const views = occurrences(source, 'staleTime: STALE.browse');
      browse += views;

      expect(`${id}: ${occurrences(source, '...LIVE')} live for ${views} browse`).toBe(
        `${id}: ${views} live for ${views} browse`,
      );

      // And keyed under the guild through the shared factory, so leaving the server clears them
      // with everything else it owns.
      expect(`${id}: ${occurrences(source, 'queryKey: queryKeys.view(guildId,')} keyed`).toBe(
        `${id}: ${views} keyed`,
      );
    }

    expect(browse).toBeGreaterThan(0);
  });

  test('focus refetching stays opt-in, so a new query cannot become chatty by omission', () => {
    expect(read('lib', 'query-client.ts')).toContain('refetchOnWindowFocus: false');
  });
});
