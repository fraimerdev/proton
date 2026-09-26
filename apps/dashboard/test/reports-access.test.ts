import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const SERVER = 'server/reports.ts';

const BROWSER_SAFE = new Set([
  'config',
  'reports-view',
  'placeholders',
  'rule-summary',
  'report-card',
]);

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
  'searchReports',
  'getReportSummary',
  'getReport',
  'listReportAutomationRuns',
  'getCaseEvidence',
] as const;

describe('the report server functions', () => {
  test('are exactly the five reads and the one action', () => {
    const exported = [...source(SERVER).matchAll(/export const (\w+) = createServerFn/g)].map(
      (match) => match[1],
    );

    expect(new Set(exported)).toEqual(new Set([...READS, 'actOnReport']));
  });

  test.each([...READS])('%s is a GET behind the guild access check', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('.middleware([requireGuildAccess])');
    expect(declared).not.toContain('requireManageGuild');
    expect(declared).not.toContain('withAudit');
  });

  test('the queue search validates the list query schema with the guild added', () => {
    const declared = declaration(SERVER, 'searchReports');

    expect(declared).toContain(
      '.validator(reportListQuerySchema.extend({ guildId: z.string().min(1) }))',
    );
    expect(declared).toContain('api.searchReports(guildId, query, await getDiscordUserId(');
  });

  test.each([
    'searchReports',
    'getReportSummary',
    'getReport',
    'listReportAutomationRuns',
  ] as const)('%s tells the api who is looking, from the session, never the browser', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain('await getDiscordUserId(context.session.user.id)');
    expect(declared).not.toContain('viewerId:');
  });

  test('the list schemas refuse a viewer id from the browser', async () => {
    const { reportListQuerySchema, automationRunListQuerySchema } = await import(
      '../src/lib/api-client.ts'
    );

    expect(reportListQuerySchema.parse({ viewerId: '400000000000000001' })).not.toHaveProperty(
      'viewerId',
    );
    expect(
      automationRunListQuerySchema.parse({ viewerId: '400000000000000001' }),
    ).not.toHaveProperty('viewerId');
  });

  test('case evidence only takes a well-formed case id', () => {
    expect(declaration(SERVER, 'getCaseEvidence')).toContain('caseId: caseIdSchema');
  });

  test('acting on a report is a POST behind Manage Server, stamped for the audit trail', () => {
    const declared = declaration(SERVER, 'actOnReport');

    expect(declared).toContain("createServerFn({ method: 'POST' })");
    expect(declared).toContain('.middleware([requireManageGuild])');
    expect(declared).not.toContain('requireGuildAccess');
    expect(declared).toContain('withAudit(context.session.user.id, (stamp) =>');
    expect(declared).toContain('api.actOnReport(guildId, reportId, {');
  });

  test('the actor’s permissions come from the access check, never from the browser', () => {
    const declared = declaration(SERVER, 'actOnReport');

    expect(declared).toContain('.pick({ action: true, params: true, requestId: true })');
    expect(declared).toContain('actorPermissions: context.access.permissions.toString()');
    expect(declared.indexOf('...body')).toBeLessThan(declared.indexOf('actorPermissions:'));
    expect(declared.indexOf('actorPermissions:')).toBeLessThan(declared.indexOf('...stamp'));
  });

  test('the session carries the viewer’s Discord id, so the page can hide what they may not decide', () => {
    const declared = declaration('server/modules.ts', 'listGuilds');

    expect(declared).toContain('profile !== null ? profile.id : getDiscordUserId(user.id)');
    expect(declared).toContain('discordId,');
    expect(source('pages/moderation/reports/detail.tsx')).toContain(
      'id: session?.user.discordId ?? null',
    );
  });

  test('a review dialog cannot be closed while Proton is still answering it', () => {
    const detail = source('pages/moderation/reports/detail.tsx');

    expect(detail.match(/dismissible=\{!pending\}/g)).toHaveLength(4);

    const lateAnswer = detail.indexOf('} else if (!shown.current) {\n          onDone(refusalOf(');
    expect(lateAnswer).toBeGreaterThan(-1);
    expect(lateAnswer).toBeLessThan(detail.indexOf("setStep('recent');"));
  });

  test('the page reads and acts through those server functions', () => {
    const queries = source('pages/moderation/reports/queries.ts');

    expect(queries).toContain("from '../../../server/reports.ts'");
    for (const name of [...READS, 'actOnReport']) expect(queries).toContain(name);
  });
});

describe('the dashboard’s moderation imports', () => {
  // The barrel drags ioredis and drizzle into the browser bundle, and nothing looks wrong until hydration fails.
  test('never reach the module barrel', () => {
    const offenders = sources(SRC).filter((file) =>
      /from '@proton\/module-moderation'/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  test('reach only the browser-safe subpaths', () => {
    const reached = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '@proton\/module-moderation\/([^']+)'/g)].map(
        (match) => match[1] ?? '',
      ),
    );

    expect(reached.filter((subpath) => !BROWSER_SAFE.has(subpath))).toEqual([]);
  });

  test('the report view the dashboard parses with imports nothing but zod, core and its types', () => {
    const reports = join(ROOT, '..', '..', 'packages', 'modules', 'moderation', 'src', 'reports');
    const imports = (file: string) =>
      new Set(
        [...readFileSync(join(reports, file), 'utf8').matchAll(/from '([^']+)'/g)].map(
          (match) => match[1],
        ),
      );

    expect(imports('view.ts')).toEqual(new Set(['@proton/core', 'zod', './types.ts']));
    expect(imports('types.ts')).toEqual(new Set(['@proton/core', 'zod']));
  });
});
