import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DRAFT_EXPIRY_DEFAULT_DAYS,
  RETENTION_DEFAULT_DAYS,
} from '@proton/module-applications/constants';
import {
  draftSaveBodySchema,
  portalRespondBodySchema,
  portalSubmitBodySchema,
  portalWithdrawBodySchema,
} from '@proton/module-applications/view';

const SRC = join(import.meta.dir, '..', 'src');
const SERVER = 'server/apply.ts';

const READS = ['listMyApplications', 'getApplyServer', 'getApplyForm', 'getApplicationStatus'];
const WRITES = [
  'saveApplyDraft',
  'submitApplyForm',
  'discardApplyDraft',
  'withdrawApplication',
  'respondToApplication',
];
const SCHEMAS = [
  'getApplyServerSchema',
  'getApplyFormSchema',
  'saveApplyDraftSchema',
  'submitApplyFormSchema',
  'discardApplyDraftSchema',
  'getApplicationStatusSchema',
  'withdrawApplicationSchema',
  'respondToApplicationSchema',
];

const ROUTES = [
  'routes/apply/index.tsx',
  'routes/apply/$guildId/index.tsx',
  'routes/apply/$guildId/$formId.tsx',
  'routes/applications/$guildId/$applicationId.tsx',
];

const PAGES = [
  'pages/apply/shared.tsx',
  'pages/apply/list.tsx',
  'pages/apply/form-page.tsx',
  'pages/apply/status-page.tsx',
  'pages/apply/question-input.tsx',
  'pages/apply/autosave.ts',
];

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

const REQUEST_ID = 'abcdefgh12345678';

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

function imports(file: string): string[] {
  return [...source(file).matchAll(/from '(@proton\/module-applications[^']*)'/g)].map(
    (match) => match[1] ?? '',
  );
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

describe('the applicant server functions', () => {
  test('are exactly the four reads and the five writes', () => {
    const exported = [...source(SERVER).matchAll(/export const (\w+) = createServerFn/g)].map(
      (match) => match[1],
    );

    expect(new Set(exported)).toEqual(new Set([...READS, ...WRITES]));
  });

  test.each([...READS, ...WRITES])('%s needs a session and nothing an admin has', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain('.middleware([requireSession])');
    expect(declared).not.toContain('requireGuildAccess');
    expect(declared).not.toContain('requireGuildMember');
    expect(declared).not.toContain('requireManageGuild');
    expect(declared).not.toContain('requirePermission');
  });

  test.each(READS)('%s is a GET that names the applicant from the session', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('const userId = await getDiscordUserId(context.session.user.id);');
    expect(declared).not.toContain('withAudit');
  });

  test.each(WRITES)('%s is a POST that names the applicant from the session', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'POST' })");
    expect(declared).toMatch(/withAudit\(context\.session\.user\.id, (?:async )?\(stamp\) =>/);
    expect(declared).toContain('userId: stamp.actorId');
  });

  test('never takes an applicant id from the browser', () => {
    const server = source(SERVER);

    expect(server).not.toContain('data.userId');
    expect(server).not.toMatch(/userId: data\b/);
    for (const name of SCHEMAS) expect(declaration(SERVER, name)).not.toContain('userId');
  });

  test('the api refuses a portal write that carries no applicant', () => {
    expect(
      draftSaveBodySchema.safeParse({ answers: {}, expectedRevision: null, requestId: REQUEST_ID })
        .success,
    ).toBe(false);
    expect(
      portalSubmitBodySchema.safeParse({ expectedRevision: 1, requestId: REQUEST_ID }).success,
    ).toBe(false);
    expect(portalWithdrawBodySchema.safeParse({ requestId: REQUEST_ID }).success).toBe(false);
    expect(
      portalRespondBodySchema.safeParse({ message: 'Here you go', requestId: REQUEST_ID }).success,
    ).toBe(false);
  });

  test('reaches the api through the applications helpers, never the shared client', () => {
    const server = source(SERVER);

    expect(server).toContain("from './applications-api.ts'");
    expect(server).not.toContain('api-client');
  });

  test('a draft save names the version the page shows, and the api reads it', () => {
    expect(declaration(SERVER, 'saveApplyDraftSchema')).toContain(
      'versionId: draftSaveBodySchema.shape.versionId',
    );
    expect(declaration(SERVER, 'saveApplyDraft')).toContain('{ versionId }');
    expect(
      draftSaveBodySchema.parse({
        userId: '100000000000000001',
        answers: {},
        expectedRevision: null,
        requestId: REQUEST_ID,
        versionId: 'version-2',
      }).versionId,
    ).toBe('version-2');

    const page = source('pages/apply/form-page.tsx');
    expect(page).toContain('const versionId = portal.versionId;');
    expect(page.match(/formId,\s+versionId,/g)?.length).toBe(2);
  });

  test('turns every refusal into a result instead of a throw', () => {
    const server = source(SERVER);

    expect(server).not.toMatch(/\bthrow new\b/);
  });
});

describe('the applicant pages', () => {
  test.each(ROUTES)('%s asks for sign-in with an explanation, never a redirect', (file) => {
    const route = source(file);

    expect(route).toContain('applyEntry(');
    expect(route).toContain('location.href');
    expect(route).toContain('<ApplyGate entry={entry}');
    expect(route).not.toContain('redirect(');
    expect(route).not.toContain('/dashboard');
  });

  test('read and write only through the applicant server functions', () => {
    const pages = PAGES.map(source).join('\n');

    for (const name of [...READS, ...WRITES]) expect(pages).toContain(name);
    expect(pages).not.toContain("from '../../server/applications.ts'");
    expect(pages).not.toContain("from '../../server/applications-admin.ts'");
  });

  test('the sign-in card says what signing in reads', () => {
    expect(source('pages/apply/shared.tsx').replace(/\s+/g, ' ')).toContain(
      'Proton reads your Discord user ID, name and avatar and the servers you’re in, and nothing else.',
    );
  });

  test('keep em dashes out of everything an applicant reads', () => {
    const offenders = [...ROUTES, ...PAGES, SERVER].filter((file) => source(file).includes('—'));
    expect(offenders).toEqual([]);
  });
});

describe('the applicant imports', () => {
  // The barrel drags drizzle into the browser bundle, and nothing looks wrong until hydration fails.
  test('never reach the module barrel', () => {
    const offenders = [...ROUTES, ...PAGES, SERVER].filter((file) =>
      imports(file).includes('@proton/module-applications'),
    );

    expect(offenders).toEqual([]);
  });

  test('reach only browser-safe subpaths, the server file included', () => {
    const reached = [...ROUTES, ...PAGES, SERVER].flatMap((file) =>
      imports(file).map((path) => `${file}: ${path.replace('@proton/module-applications/', '')}`),
    );

    expect(reached.filter((line) => !BROWSER_SAFE.has(line.split(': ')[1] ?? ''))).toEqual([]);
  });

  test('keep the question inputs and autosave free of server functions, so they render anywhere', () => {
    for (const file of ['pages/apply/question-input.tsx', 'pages/apply/autosave.ts']) {
      expect(source(file)).not.toContain('/server/');
      expect(source(file)).not.toContain('lib/queries');
    }
  });

  test('never reach the admin-only server functions from browser code', () => {
    const offenders = sources(join(SRC, 'pages', 'apply'))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'))
      .filter((file) =>
        /server\/(?:applications|applications-admin|modules)\.ts/.test(source(file)),
      );

    expect(offenders).toEqual([]);
  });
});

describe('the privacy page', () => {
  const privacy = source('routes/privacy.tsx').replace(/\s+/g, ' ');

  test('covers Applications with the retention the code uses', () => {
    expect(privacy).toContain('<strong>Applications</strong>');
    expect(privacy).toContain(`draft expiry, ${DRAFT_EXPIRY_DEFAULT_DAYS} days unless`);
    expect(privacy).toContain(`expires, ${RETENTION_DEFAULT_DAYS} unless`);
    expect(privacy).toContain('so Proton never downloads any');
    expect(privacy).toContain('never staff notes or votes');
  });
});
