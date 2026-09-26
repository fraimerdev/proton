import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOINROLES_RUN_KINDS } from '@proton/core';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

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

describe('the Join Roles sync server functions', () => {
  test('reading the status is a GET behind the guild access check', () => {
    const declared = declaration('server/joinroles.ts', 'getJoinRolesSync');

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('.middleware([requireGuildAccess])');
    expect(declared).toContain('guildId: z.string().min(1)');
    expect(declared).toContain('api.getJoinRolesSync(data.guildId)');
  });

  test('starting a run is a POST behind Manage Server, stamped for the audit trail', () => {
    const declared = declaration('server/joinroles.ts', 'startJoinRolesSync');

    expect(declared).toContain("createServerFn({ method: 'POST' })");
    expect(declared).toContain('.middleware([requireManageGuild])');
    expect(declared).not.toContain('requireGuildAccess');
    expect(declared).toContain('kind: z.enum(JOINROLES_RUN_KINDS)');
    expect(declared).toContain('withAudit(context.session.user.id, (stamp) =>');
    expect(declared).toContain(
      'api.startJoinRolesSync(data.guildId, { kind: data.kind, ...stamp })',
    );
  });

  test('the kinds a start accepts are exactly sync and count', () => {
    expect([...JOINROLES_RUN_KINDS]).toEqual(['sync', 'count']);
  });

  test('the page reads and starts through those server functions', () => {
    expect(source('lib/queries.ts')).toContain(
      "import { getJoinRolesSync, startJoinRolesSync } from '../server/joinroles.ts';",
    );
  });
});

describe('the Sync tab announces what a run is doing', () => {
  test('the status sits in one live region that stays mounted from queued to finished', () => {
    const text = source('pages/joinroles/sync.tsx');
    const start = text.indexOf('function Progress(');
    const body = text.slice(start, text.indexOf('\n}\n', start));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain('return (\n    <div aria-live="polite">');
    expect(body).not.toContain('return null');
    expect(body).not.toContain('AsyncOperationStatus');
    expect(text.match(/<Progress\b/g)).toHaveLength(2);
  });
});

describe('the dashboard’s Join Roles imports', () => {
  // The barrel drags ioredis and drizzle into the browser bundle, and nothing looks wrong until hydration fails.
  test('never reach the module barrel, only its browser-safe subpaths', () => {
    const offenders = sources(SRC).filter((file) =>
      /from '@proton\/module-joinroles'/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  test('the sync view the page parses with imports nothing but zod, core and the config', () => {
    const view = readFileSync(
      join(ROOT, '..', '..', 'packages', 'modules', 'joinroles', 'src', 'sync', 'view.ts'),
      'utf8',
    );
    const imports = [...view.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(new Set(imports)).toEqual(new Set(['@proton/core', 'zod', '../config.ts']));
  });
});
