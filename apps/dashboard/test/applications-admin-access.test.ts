import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const SERVER = 'server/applications-admin.ts';

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

const ADMIN_FILES = [
  'pages/applications.tsx',
  'pages/applications/shape.ts',
  'pages/applications/forms.tsx',
  'pages/applications/create-dialog.tsx',
  'pages/applications/editor.tsx',
  'pages/applications/questions.tsx',
  'pages/applications/question-detail.tsx',
  'pages/applications/requirements.tsx',
  'pages/applications/review-settings.tsx',
  'pages/applications/messages.tsx',
  'pages/applications/actions.tsx',
  'pages/applications/intake.tsx',
  'pages/applications/publish-dialog.tsx',
  'pages/applications/panels.tsx',
  'pages/applications/panel-editor.tsx',
  'pages/applications/settings.tsx',
  'pages/applications/admin-queries.ts',
  SERVER,
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

const READS = [
  'getApplicationForms',
  'getApplicationFormVersions',
  'getApplicationFormVersion',
  'previewApplicationEligibility',
  'getReviewAudience',
] as const;

describe('the applications admin server functions', () => {
  test('are exactly the five reads and publishing', () => {
    const exported = [...source(SERVER).matchAll(/export const (\w+) = createServerFn/g)].map(
      (match) => match[1],
    );

    expect(new Set(exported)).toEqual(new Set([...READS, 'publishApplicationForm']));
  });

  test.each([...READS])('%s is a GET behind the admin access check', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('.middleware([requireGuildAccess])');
    expect(declared).not.toContain('requireManageGuild');
    expect(declared).not.toContain('requireGuildMember');
    expect(declared).not.toContain('withAudit');
  });

  test('publishing is a POST behind Manage Server, stamped for the audit trail', () => {
    const declared = declaration(SERVER, 'publishApplicationForm');

    expect(declared).toContain("createServerFn({ method: 'POST' })");
    expect(declared).toContain('.middleware([requireManageGuild])');
    expect(declared).not.toContain('requireGuildAccess');
    expect(declared).toContain('withAudit(context.session.user.id, (stamp) =>');
    expect(declared).toContain('{ ...body, ...stamp }');
  });

  test('the publisher’s identity comes from the session, never from the browser', () => {
    const text = source(SERVER);

    expect(text).toContain('.pick({ requestId: true, draftPolicy: true })');
    expect(text).not.toMatch(/actorId\s*:/);
    expect(text).not.toMatch(/viewerId/);
  });

  test('reads never forward who is looking, and every call goes through the shared api helpers', () => {
    const text = source(SERVER);

    expect(text).not.toContain('fetch(');
    expect(text).not.toContain('new ApiClient');
    expect(text).toContain("from './applications-api.ts'");
  });

  test('a refused publish comes back as a result, so its reason reaches the page', () => {
    const text = source(SERVER);

    expect(text).toContain('export type PublishOutcome =');
    expect(text).toContain('return { ok: false, message: refusal.data.message };');
  });

  test('exports input types for callers', () => {
    const text = source(SERVER);

    for (const name of [
      'PublishApplicationFormInput',
      'ApplicationFormVersionsInput',
      'ApplicationFormVersionInput',
      'EligibilityPreviewInput',
      'ReviewAudienceInput',
    ]) {
      expect(text).toContain(`export type ${name} = z.input<`);
    }
  });
});

describe('the applications pages', () => {
  test('import only the browser-safe subpaths of the module', () => {
    const files = [
      join(SRC, 'pages', 'applications.tsx'),
      ...sources(join(SRC, 'pages', 'applications')),
    ];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');

      expect(text).not.toMatch(/from '@proton\/module-applications'/);

      for (const match of text.matchAll(/from '@proton\/module-applications\/([\w-]+)'/g)) {
        expect(BROWSER_SAFE.has(match[1] ?? '')).toBe(true);
      }
    }
  });

  test('never call the api or Discord from the browser', () => {
    for (const file of ADMIN_FILES.filter((name) => name.startsWith('pages/'))) {
      const text = source(file);

      expect(text).not.toContain('fetch(');
      expect(text).not.toContain('applications-api.ts');
      expect(text).not.toMatch(/^import (?!type )[^;]*from '(\.\.\/)+lib\/discord\.ts'/m);
    }
  });

  test('carry no em dash in anything they say', () => {
    for (const file of ADMIN_FILES) {
      expect(source(file)).not.toContain('—');
    }
  });

  test('never use a native select', () => {
    for (const file of ADMIN_FILES.filter((name) => name.endsWith('.tsx'))) {
      expect(source(file)).not.toContain('<select');
    }
  });

  test('size every dialog', () => {
    for (const file of ADMIN_FILES.filter((name) => name.endsWith('.tsx'))) {
      const text = source(file);
      const opened = [...text.matchAll(/<Dialog\b[^>]*?>/gs)];

      for (const [tag] of opened) {
        expect(tag).toMatch(/size="(compact|medium|large)"/);
      }
    }
  });

  test('the module page has a generated route', () => {
    const route = readFileSync(
      join(SRC, 'routes', 'dashboard', '$guildId', 'applications.tsx'),
      'utf8',
    );

    expect(route).toContain('Generated by scripts/build-routes.ts');
    expect(route).toContain("import Page from '../../../pages/applications.tsx';");
  });
});
