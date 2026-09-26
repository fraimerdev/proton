import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { queueQuerySchema, staffActionSchema } from '@proton/module-applications/view';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const SERVER = 'server/applications.ts';
const EXPORT_ROUTE = 'routes/api/guilds/$guildId/applications-export.ts';

const READS = ['searchApplications', 'applicationsSummary', 'getApplication', 'applicationMembers'];
const WRITES = ['actOnApplication', 'deleteApplicantData'];

const BROWSER_SAFE = new Set([
  'config',
  'view',
  'web',
  'templates',
  'questions',
  'placeholders',
  'simulation',
  'status',
  'intake',
  'version',
  'constants',
]);

const OWNED_UI = [
  'pages/applications/submissions.tsx',
  'pages/applications/queue.tsx',
  'pages/applications/detail.tsx',
  'pages/applications/dialogs.tsx',
  'pages/applications/timeline.tsx',
  'pages/applications/effects.tsx',
  'pages/applications/answers.tsx',
  'pages/applications/labels.ts',
  'routes/review/$guildId/index.tsx',
  'routes/review/$guildId/$applicationId.tsx',
  EXPORT_ROUTE,
];

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

function declaration(file: string, name: string): string {
  const text = source(file);
  const start = text.indexOf(`export const ${name} = `);
  const next = text.indexOf('\nexport ', start + 1);

  expect(start).toBeGreaterThanOrEqual(0);

  return text.slice(start, next === -1 ? undefined : next);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

function serverSide(file: string): boolean {
  const path = relative(SRC, file).replaceAll('\\', '/');
  return path.startsWith('server/') || path.startsWith('routes/api/');
}

describe('the application review server functions', () => {
  test('are exactly the four reads and the two writes', () => {
    const exported = [...source(SERVER).matchAll(/export const (\w+) = createServerFn/g)].map(
      (match) => match[1],
    );

    expect(new Set(exported)).toEqual(new Set([...READS, ...WRITES]));
  });

  test.each(READS)('%s is a GET behind the membership check, never an admin gate', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('.middleware([requireGuildMember])');
    expect(declared).not.toContain('requireGuildAccess');
    expect(declared).not.toContain('requireManageGuild');
    expect(declared).not.toContain('withAudit');
  });

  test.each(READS)('%s tells the api who is looking, from the session only', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain('const viewerId = await getDiscordUserId(context.session.user.id);');
    expect(declared).toMatch(/apiQuery\(\{[^}]*\bviewerId,?\s*\}\)/);
    expect(declared).not.toContain('viewerId:');
    expect(declared).not.toContain('data.viewerId');
  });

  test.each(WRITES)('%s is a POST behind the membership check, stamped for audit', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'POST' })");
    expect(declared).toContain('.middleware([requireGuildMember])');
    expect(declared).toContain('withAudit(context.session.user.id, (stamp) =>');
    expect(declared).not.toContain('requireManageGuild');
    expect(declared).not.toContain('actorId: data');
  });

  test('the queue search validates the shared query schema with the server added', () => {
    expect(declaration(SERVER, 'searchApplicationsSchema')).toContain(
      'queueQuerySchema.extend({ guildId: snowflakeSchema })',
    );
    expect(declaration(SERVER, 'searchApplications')).toContain(
      '.validator(searchApplicationsSchema)',
    );
  });

  test('the query schema drops a viewer id sent from the browser', () => {
    expect(queueQuerySchema.parse({ viewerId: '400000000000000001' })).not.toHaveProperty(
      'viewerId',
    );
  });

  test('an action’s actor and request id come from the server, after anything the browser sent', () => {
    const declared = declaration(SERVER, 'actOnApplication');

    expect(declared).toContain('const params = unstamped(request);');
    expect(declared).toMatch(/\.\.\.params,[\s\S]*\brequestId,\s*\.\.\.stamp,\s*\}\);/);
    expect(declared).toContain("params.assigneeId === 'me'");
    expect(declared).toContain('assigneeId: stamp.actorId');
    expect(declared).toContain('staffActionSchema.safeParse(');
    expect(source(SERVER)).toContain("new Set(['actorId', 'source', 'ipHash', 'requestId'])");
  });

  test('the api’s action schema still needs the stamp the server adds', () => {
    const parsed = staffActionSchema.safeParse({ action: 'claim', requestId: 'abcdefgh12345678' });
    expect(parsed.success).toBe(false);
  });

  test('deleting an applicant’s data confirms on the server, not in the browser', () => {
    const declared = declaration(SERVER, 'deleteApplicantData');
    const confirmed = 'deleteApplicantBodySchema.parse({ confirm: true, requestId, ...stamp })';

    expect(declared).toContain(confirmed);
    expect(declaration(SERVER, 'deleteApplicantDataSchema')).not.toContain('confirm');
  });

  test('the page reads and acts only through these server functions', () => {
    const queries = source('pages/applications/queries.ts');

    expect(queries).toContain("from '../../server/applications.ts'");
    for (const name of [...READS, ...WRITES]) expect(queries).toContain(name);
  });
});

describe('the export download', () => {
  const route = source(EXPORT_ROUTE);

  test('checks the session and server membership before asking the api', () => {
    const guilds = 'fetchUserGuilds(env.REST_PROXY_URL, token).catch(expiredSignInResponse)';

    expect(route).toContain('auth.api.getSession({ headers: request.headers })');
    expect(route).toContain(guilds);
    expect(route).toContain('guilds.some((guild) => guild.id === guildId)');
    expect(route.indexOf('viewerOf(request, params.guildId)')).toBeLessThan(
      route.indexOf('rawApplicationsApi('),
    );
  });

  test('names the viewer from the session, and leaves the capability check to the api', () => {
    expect(route).toContain('return getDiscordUserId(session.user.id);');
    expect(route).toContain('viewerId: viewer');
    expect(route).not.toContain('accessGrants');
    expect(route).not.toContain('resolveGuildAccess');
  });

  test('is never cached and never sniffed', () => {
    expect(route).toContain("'cache-control': 'no-store'");
    expect(route).toContain("'x-content-type-options': 'nosniff'");
  });
});

describe('the reviewer pages', () => {
  test('live outside the admin shell and explain sign-in instead of redirecting', () => {
    const routes = [
      'routes/review/$guildId/index.tsx',
      'routes/review/$guildId/$applicationId.tsx',
    ];

    for (const file of routes) {
      const route = source(file);
      expect(route).toContain('reviewEntry(context.queryClient, params.guildId, location.href)');
      expect(route).toContain('<ReviewGate entry={entry} />');
      expect(route).toContain('surface="review"');
      expect(route).not.toContain('redirect(');
    }
  });

  test('resolve names through the reviewer-gated lookup, and the admin page keeps its own', () => {
    const area = source('pages/applications/submissions.tsx');
    expect(area).toContain('const source = admin ? undefined : applicationMembersQuery;');

    const provider = source('components/discord/member.tsx');
    expect(provider).toContain('useQuery(membersQuery(guildId, userIds))');
    expect(provider).toContain('if (source !== undefined)');
  });

  test('a dialog can’t be closed while Proton is still answering it', () => {
    const dialogs = source('pages/applications/dialogs.tsx');
    const opened = dialogs.match(/<Dialog\b/g) ?? [];
    const guarded = dialogs.match(/dismissible=\{!(?:pending|isPending)\}/g) ?? [];

    expect(opened.length).toBeGreaterThan(5);
    expect(guarded).toHaveLength(opened.length);
  });
});

describe('the dashboard’s applications imports', () => {
  // The barrel drags drizzle into the browser bundle, and nothing looks wrong until hydration fails.
  test('never reach the module barrel', () => {
    const offenders = sources(SRC).filter((file) =>
      /from '@proton\/module-applications'/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  test('reach only the browser-safe subpaths from browser code', () => {
    const reached = sources(SRC)
      .filter((file) => !serverSide(file))
      .flatMap((file) =>
        [
          ...readFileSync(file, 'utf8').matchAll(/from '@proton\/module-applications\/([^']+)'/g),
        ].map((match) => `${relative(SRC, file)}: ${match[1] ?? ''}`),
      );

    expect(reached.filter((line) => !BROWSER_SAFE.has(line.split(': ')[1] ?? ''))).toEqual([]);
  });

  test('keep em dashes out of everything a reviewer reads', () => {
    const offenders = OWNED_UI.filter((file) => source(file).includes('—'));
    expect(offenders).toEqual([]);
  });
});
