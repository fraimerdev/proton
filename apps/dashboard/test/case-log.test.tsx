import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_KINDS,
  AUTO_REVERSAL_ACTOR,
  CASE_SCOPES,
  type CaseRecord,
  caseQuerySchema,
  isModerationActionKind,
} from '@proton/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';

const SRC = join(import.meta.dir, '..', 'src');

const GUILD = '900000000000000002';
const MODERATOR = '225176015016558593';
const MEMBER = '400000000000000002';
const EARLIER_MODERATOR = '400000000000000003';
const REPORT = 'Rk7f3M2q';
const CASE = 'K7f3M2q';
const FETCHED = Date.parse('2026-09-19T11:20:00.000Z');

const CHANNELS = [{ id: '500000000000000001', name: 'commands', type: 0, parentId: null }];
const ROLES = [{ id: '600000000000000001', name: 'Staff' }];

const calls: { name: string; data: unknown }[] = [];
const answers: Record<string, (data: unknown) => unknown> = {};

for (const file of readdirSync(join(SRC, 'server'))) {
  const source = readFileSync(join(SRC, 'server', file), 'utf8');
  const names = [...source.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(
    ([, name]) => name as string,
  );

  mock.module(`../src/server/${file}`, () =>
    Object.fromEntries(
      names.map((name) => [
        name,
        async (input?: { data?: unknown }) => {
          calls.push({ name, data: input?.data });
          return answers[name]?.(input?.data) ?? null;
        },
      ]),
    ),
  );
}

const later = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 25));

const QUERIES = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () => ({
  ...Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
    ]),
  ),
  MEMBER_LOOKUP_MAX: 100,
  membersQuery: (guildId: string, userIds: readonly string[]) => ({
    queryKey: ['case-log', 'members', guildId, ...[...new Set(userIds)].sort()],
    queryFn: async () => [],
    enabled: userIds.length > 0,
  }),
  channelsQuery: (guildId: string) => ({
    queryKey: ['case-log', 'channels', guildId],
    queryFn: () => later(CHANNELS),
  }),
  rolesQuery: (guildId: string) => ({
    queryKey: ['case-log', 'roles', guildId],
    queryFn: () => later(ROLES),
  }),
}));

const route = await import('../src/components/module/route.tsx');
let search: Record<string, unknown> = {};

mock.module('../src/components/module/route.tsx', () => ({
  ...route,
  useModuleSearch: () => search,
  useModuleNavigate: () => () => undefined,
}));

const { CaseLogArea, moderatorOf, requesterOf } = await import('../src/pages/cases/log.tsx');
const { CASE_LOCAL_DEFAULTS, caseFilter, caseStatus, caseView } = await import(
  '../src/pages/cases/queries.ts'
);
const { prefetchArea } = await import('../src/lib/modules/area-prefetch.ts');
const { caseCountQuery } = await import('../src/pages/moderation/queries.ts');
const { channelsQuery, membersQuery, rolesQuery } = await import('../src/lib/queries.ts');

afterEach(() => {
  setSystemTime();
  calls.length = 0;
  for (const name of Object.keys(answers)) delete answers[name];
});

function record(overrides: Partial<CaseRecord>): CaseRecord {
  return {
    id: 'z2LcQRB',
    caseNumber: 92,
    type: 'kick',
    actorId: MODERATOR,
    targetId: MEMBER,
    moderatorId: MODERATOR,
    reason: 'spam',
    moduleId: 'moderation',
    expiresAt: null,
    revertedAt: null,
    revertedBy: null,
    dryRun: false,
    createdAt: new Date(FETCHED - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const ROWS: CaseRecord[] = [
  record({}),
  record({
    id: 'a8Kd02x',
    caseNumber: 91,
    type: 'timeout',
    actorId: 'proton:automod',
    moderatorId: null,
    moduleId: 'automod',
    reason: 'Blocked word',
    expiresAt: new Date(FETCHED + 10 * 60_000).toISOString(),
  }),
  record({
    id: 'b7Qz11c',
    caseNumber: 90,
    type: 'ban',
    actorId: EARLIER_MODERATOR,
    moderatorId: EARLIER_MODERATOR,
    reason: 'raid',
  }),
  record({ id: 'c6Wm20v', caseNumber: 89, actorId: null, moderatorId: null, reason: 'old' }),
  record({
    id: 'd5Xn39b',
    caseNumber: 88,
    type: 'unban',
    actorId: MODERATOR,
    moderatorId: null,
    reason: 'Temporary ban expired.',
  }),
];

const MEMBERS = [
  { id: MODERATOR, displayName: 'Solus', username: 'solus', avatarUrl: null, bot: false },
  { id: MEMBER, displayName: 'Riley', username: 'riley', avatarUrl: null, bot: false },
  { id: EARLIER_MODERATOR, displayName: 'Casey', username: 'casey', avatarUrl: null, bot: false },
];

async function serverRender(
  link: Record<string, unknown>,
  renderedAt = FETCHED,
): Promise<{ html: string; scope: unknown }> {
  search = link;
  calls.length = 0;
  answers.searchCases = () => ({ cases: ROWS, total: ROWS.length, page: 1, pageSize: 50 });

  const client = new QueryClient();
  setSystemTime(new Date(FETCHED));
  await prefetchArea(client, GUILD, 'cases', link);
  client.setQueryData(
    membersQuery(GUILD, [MEMBER, MODERATOR, EARLIER_MODERATOR]).queryKey,
    MEMBERS,
  );

  const fetched = calls.filter((call) => call.name === 'searchCases');
  expect(fetched).toHaveLength(1);

  setSystemTime(new Date(renderedAt));
  const html = renderToString(
    <QueryClientProvider client={client}>
      <CaseLogArea guildId={GUILD} moduleId="cases" />
    </QueryClientProvider>,
  );

  return { html, scope: (fetched[0]?.data as { scope?: unknown } | undefined)?.scope };
}

describe('the case log’s link state', () => {
  test('no status is the moderation log, and "all" is every action', () => {
    expect(caseView(undefined)).toEqual({ scope: 'moderation', type: undefined });
    expect(caseView('all')).toEqual({ scope: 'all', type: undefined });
  });

  test('a moderation type stays in the moderation log, and any other type opens all actions', () => {
    expect(caseView('ban')).toEqual({ scope: 'moderation', type: 'ban' });
    expect(caseView('send')).toEqual({ scope: 'all', type: 'send' });
  });

  test('a moderation type picked under all actions keeps the all-actions tab', () => {
    expect(caseStatus({ scope: 'all', type: 'ban' })).toBe('all-ban');
    expect(caseView('all-ban')).toEqual({ scope: 'all', type: 'ban' });
  });

  test('unknown values fall back to no type, in the scope they asked for', () => {
    expect(caseView('nonsense')).toEqual({ scope: 'moderation', type: undefined });
    expect(caseView('all-nonsense')).toEqual({ scope: 'all', type: undefined });
  });

  test('every scope and type the page can pick survives the trip through the link', () => {
    for (const scope of CASE_SCOPES) {
      for (const type of [undefined, ...ACTION_KINDS]) {
        if (scope === 'moderation' && type !== undefined && !isModerationActionKind(type)) continue;
        expect(caseView(caseStatus({ scope, type }))).toEqual({ scope, type });
      }
    }
  });

  test('moving to the moderation log drops a type it cannot hold and keeps one it can', () => {
    expect(caseStatus({ scope: 'moderation', type: 'send' })).toBeUndefined();
    expect(caseStatus({ scope: 'moderation', type: 'timeout' })).toBe('timeout');
  });

  test('a case ID searches every action, because the links that carry one name no tab', () => {
    expect(caseFilter({}, CASE_LOCAL_DEFAULTS).scope).toBe('moderation');
    expect(caseFilter({ q: CASE }, CASE_LOCAL_DEFAULTS)).toMatchObject({
      caseId: CASE,
      scope: 'all',
    });
    expect(caseFilter({ q: 'not a case id' }, CASE_LOCAL_DEFAULTS).scope).toBe('moderation');
  });
});

describe('the case log a direct link renders on the server', () => {
  test('opens on moderation actions, from the rows the prefetch asked for', async () => {
    const { html, scope } = await serverRender({ area: 'log' });

    expect(scope).toBe('moderation');
    expect(html).not.toContain('Loading cases');
    expect(html).toContain('Solus');
    expect(html).toMatch(/aria-selected="true"[^>]*>Moderation<\/button>/);
    expect(html).toContain('Any moderation action');
  });

  test.each([
    { area: 'log', status: 'all' },
    { area: 'log', status: 'all-ban' },
    { area: 'log', status: 'send' },
    { area: 'log', q: CASE },
  ])('%o reaches the api as the page asks, and renders its rows', async (link) => {
    const { html, scope } = await serverRender(link);

    expect(scope).toBe('all');
    expect(html).not.toContain('Loading cases');
    expect(html).toContain('Solus');
    expect(html).toContain('Casey');
  });

  test('all actions shows as the tab it is', async () => {
    const { html } = await serverRender({ area: 'log', status: 'all' });

    expect(html).toMatch(/aria-selected="true"[^>]*>All actions<\/button>/);
    expect(html).toContain('Any action');
  });

  test('a case ID link shows the all-actions tab its search runs under', async () => {
    const { html } = await serverRender({ area: 'log', q: CASE });

    expect(html).toMatch(/aria-selected="true"[^>]*>All actions<\/button>/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Moderation<\/button>/);
    expect(html).toContain('Any action');
    expect(html).not.toContain('Any moderation action');
  });

  test('a case ID link with a moderation type still shows all actions', async () => {
    const { html } = await serverRender({ area: 'log', status: 'ban', q: CASE });

    expect(html).toMatch(/aria-selected="true"[^>]*>All actions<\/button>/);
  });

  test('the moderator is the member who acted, or Proton and the module when it acted alone', async () => {
    const { html } = await serverRender({ area: 'log' });

    expect(html).toContain('Proton · Automod');
    expect(html).toContain('Casey');
    expect(html.match(/<span class="text-muted">Unknown<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain('proton:automod');
  });

  test('a duration that ran out is Proton’s, not the moderator’s who set it', async () => {
    const { html } = await serverRender({ area: 'log' });

    expect(html).toContain('Proton · Moderation');
  });

  test('renders the same text whichever minute the server and the browser read', async () => {
    const server = await serverRender({ area: 'log' });
    const browser = await serverRender({ area: 'log' }, FETCHED + 3 * 60_000 + 7_000);

    expect(browser.html).toBe(server.html);
    expect(server.html).toContain('5m ago');
    expect(server.html).toContain('Expires in 10m');
    expect(server.html).not.toMatch(/<time[^>]*title=/);
  });
});

describe('who a case names', () => {
  test('the moderator is the one the api named', () => {
    expect(moderatorOf(record({ moderatorId: EARLIER_MODERATOR }))).toBe(EARLIER_MODERATOR);
  });

  test('with none named, an automatic action is the Proton actor that took it', () => {
    expect(moderatorOf(record({ moderatorId: null, actorId: 'proton:automod' }))).toBe(
      'proton:automod',
    );
    expect(moderatorOf(record({ moderatorId: null, actorId: null }))).toBeNull();
  });

  test('with none named, a member who acted only set a duration, and Proton ended it', () => {
    expect(moderatorOf(record({ moderatorId: null, actorId: EARLIER_MODERATOR }))).toBe(
      AUTO_REVERSAL_ACTOR,
    );
  });

  test('Requested by only shows a member other than the moderator', () => {
    expect(requesterOf(record({}))).toBeNull();
    expect(requesterOf(record({ moderatorId: null }))).toBeNull();
    expect(requesterOf(record({ actorId: 'proton:reports', moderatorId: MODERATOR }))).toBeNull();
    expect(requesterOf(record({ actorId: null }))).toBeNull();
    expect(requesterOf(record({ actorId: EARLIER_MODERATOR, moderatorId: MODERATOR }))).toBe(
      EARLIER_MODERATOR,
    );
  });
});

describe('what the moderation page and the api client ask for', () => {
  test('the Case log row counts moderation cases, the ones the log opens on', async () => {
    answers.searchCases = () => ({ cases: [], total: 3, page: 1, pageSize: 1 });

    await new QueryClient().fetchQuery(caseCountQuery(GUILD));

    expect(calls.find((call) => call.name === 'searchCases')?.data).toMatchObject({
      scope: 'moderation',
    });
  });

  test('the case search carries its scope to the api', async () => {
    const realFetch = globalThis.fetch;
    let asked = '';

    globalThis.fetch = (async (url: string | URL | Request) => {
      asked = String(url);
      return new Response(JSON.stringify({ cases: [], total: 0, page: 1, pageSize: 50 }));
    }) as unknown as typeof fetch;

    try {
      const { ApiClient } = await import('../src/lib/api-client.ts');
      await new ApiClient('http://api.test', 'secret').searchCases(
        GUILD,
        caseQuerySchema.parse({ scope: 'moderation' }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(new URL(asked).searchParams.get('scope')).toBe('moderation');
  });
});

describe('the report queue a direct link renders on the server', () => {
  test('an open report waits for the channel and role names its detail prints', async () => {
    const client = new QueryClient();

    await prefetchArea(client, GUILD, 'moderation', { area: 'reports-queue', id: REPORT });

    expect(client.getQueryData<unknown>(channelsQuery(GUILD).queryKey)).toEqual(CHANNELS);
    expect(client.getQueryData<unknown>(rolesQuery(GUILD).queryKey)).toEqual(ROLES);
  });

  test('the list prints no names, so it does not wait on them', async () => {
    const client = new QueryClient();

    await prefetchArea(client, GUILD, 'moderation', { area: 'reports-queue' });

    expect(client.getQueryData(channelsQuery(GUILD).queryKey)).toBeUndefined();
  });
});
