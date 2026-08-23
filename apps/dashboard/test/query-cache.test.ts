import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashKey } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { makeQueryClient } from '../src/lib/query-client.ts';
import { queryKeys, STALE } from '../src/lib/query-keys.ts';

const SRC = join(import.meta.dir, '..', 'src');

function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

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

describe('loaders go through the cache', () => {
  const ROUTES = join(SRC, 'routes', 'dashboard');

  function route(...parts: string[]): string {
    return readFileSync(join(ROUTES, ...parts), 'utf8');
  }

  test('no route loader calls a server function directly any more', () => {
    const loaders = [
      route('index.tsx'),
      route('$guildId.tsx'),
      route('$guildId', 'index.tsx'),
      route('$guildId', '$moduleId.tsx'),
    ];

    for (const source of loaders) {
      // A route whose data its parent layout already awaited declares no loader at all — the
      // overview reads only the module list, which $guildId.tsx has to fetch anyway.
      if (!source.includes('loader:')) continue;

      const body = code(source.slice(source.indexOf('loader:'), source.indexOf('component:')));

      // fetchQuery, not ensureQueryData: ensureQueryData resolves from the cache at any age and
      // revalidates through prefetchQuery, whose rejection is swallowed — so a loader built on
      // it can neither await fresh data nor see the refusal it is supposed to redirect on.
      expect(body).toContain('fetchQuery(');
      expect(body).not.toContain('ensureQueryData');
      expect(body).not.toMatch(/\b(listGuilds|listModules|getModuleConfig|getGuild\w+)\(/);
    }
  });

  test('and the shell fetches what every page under it reads', () => {
    expect(route('$guildId.tsx')).toContain('fetchQuery(modulesQuery(params.guildId))');
    expect(route('$guildId.tsx')).toContain('fetchQuery(sessionQuery())');
  });

  // The switch is in the sidebar, which the layout owns, so a page under it must never grow its
  // own copy of the toggle: two optimistic writers on one cache entry cannot agree.
  test('only the guild layout mutates the module switch', () => {
    for (const file of ['index.tsx', '$moduleId.tsx']) {
      expect(`${file}: ${route('$guildId', file).includes('enabled: ')}`).toBe(`${file}: false`);
    }
  });

  test('the module page no longer refetches the whole route to save one form', () => {
    expect(route('$guildId', '$moduleId.tsx')).not.toContain('router.invalidate()');
    expect(route('$guildId', 'index.tsx')).not.toContain('router.invalidate()');
  });
});

describe('a view tab does not pay for the settings form', () => {
  const module = readFileSync(
    join(SRC, 'routes', 'dashboard', '$guildId', '$moduleId.tsx'),
    'utf8',
  );

  const SETTINGS_ONLY = ['moduleConfigQuery', 'channelsQuery', 'rolesQuery'];

  function loader(): string {
    return code(module.slice(module.indexOf('loader:'), module.indexOf('component: ModulePage')));
  }

  test('the loader branches on the active view before it fetches anything', () => {
    const body = loader();

    expect(body).toContain('const entry = resolveView(params.moduleId, deps.view);');
    expect(body.indexOf('resolveView')).toBeLessThan(body.indexOf('fetchQuery'));
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

  // Sliced to ModulePage's own closing brace rather than to the next component, because the
  // components between them are the ones the queries are meant to be read in.
  test('the settings queries are read where they are rendered, not in the page shell', () => {
    const from = module.slice(module.indexOf('function ModulePage('));
    const shell = from.slice(0, from.indexOf('\n}\n') + 2);

    expect(shell).toContain('function ModulePage(');
    expect(shell.length).toBeLessThan(from.length);

    for (const name of SETTINGS_ONLY) {
      expect(`${name} in ModulePage: ${shell.includes(name)}`).toBe(`${name} in ModulePage: false`);
    }
  });

  // The route component is reused across :moduleId, so without a key the next module opens holding
  // the previous one's edits. This replaced a useEffect that re-seeded four useStates by hand.
  test('the settings form is remounted per module rather than re-seeded by an effect', () => {
    expect(module).toContain('key={moduleId}');
    expect(module).not.toContain('seededFor');
  });
});

describe('what a mutation leaves behind', () => {
  const ROUTES = join(SRC, 'routes', 'dashboard');

  const shell = readFileSync(join(ROUTES, '$guildId.tsx'), 'utf8');
  const module = readFileSync(join(ROUTES, '$guildId', '$moduleId.tsx'), 'utf8');

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

  // The API normalises some configs on the way in, so the submitted values are not necessarily
  // what was stored. Seeding the baseline from them hides the difference behind a clean form.
  test('a save re-seeds the form from what the server stored, not from what was sent', () => {
    const onSuccess = module.slice(module.indexOf('onSuccess:'), module.indexOf('const dirty'));

    expect(onSuccess).toContain('reseed(result.after)');
    expect(onSuccess).not.toContain('setBaseline(submitted)');
  });

  test('an untouched form follows the config when it changes underneath', () => {
    expect(module).toContain('if (!dirty) reseed(settings);');
  });
});

describe('what a tab left open still notices', () => {
  const queries = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');
  const views = readFileSync(join(SRC, 'components', 'views', 'registry.ts'), 'utf8');

  function factories(source: string): Map<string, string> {
    const found = new Map<string, string>();

    for (const chunk of source.split('export function ').slice(1)) {
      const name = chunk.slice(0, chunk.indexOf('('));
      if (!name.endsWith('Query')) continue;

      found.set(name, chunk.slice(0, chunk.indexOf('});')));
    }

    return found;
  }

  function occurrences(source: string, needle: string): number {
    return source.split(needle).length - 1;
  }

  // Proton's own guild row moves on a join or a tier change and the field descriptors only on a
  // redeploy; everything else here is owned by Discord or by another admin, and a config dashboard
  // that never notices is worse than a chatty one.
  const OPTED_OUT = ['guildQuery', 'moduleDescriptorsQuery'];

  test('the factories this asserts over really are all of them', () => {
    expect([...factories(queries).keys()].sort()).toEqual([
      'channelsQuery',
      'guildQuery',
      'moduleConfigQuery',
      'moduleDescriptorsQuery',
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

  test('and so does every browsable view', () => {
    expect(occurrences(views, '...LIVE')).toBe(occurrences(views, 'staleTime: STALE.browse'));
  });

  test('focus refetching stays opt-in, so a new query cannot become chatty by omission', () => {
    const client = readFileSync(join(SRC, 'lib', 'query-client.ts'), 'utf8');

    expect(client).toContain('refetchOnWindowFocus: false');
  });
});
