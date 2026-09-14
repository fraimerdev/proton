import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Permissions } from '@proton/core';
import { type DiscordUserGuild, resolveGuildAccess } from '../src/lib/guild-access.ts';

const GUILD = '111111111111111111';
const OTHER = '333333333333333333';

const SRC = join(import.meta.dir, '..', 'src');

function guild(id: string, permissions: bigint, owner = false): DiscordUserGuild {
  return { id, name: id, icon: null, owner, permissions: permissions.toString() };
}

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

function declaration(file: string, name: string, until: string): string {
  const text = source(file);
  const start = text.indexOf(`export const ${name} = `);
  const end = text.indexOf(until, start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return text.slice(start, end);
}

describe('reading another server’s display name style status', () => {
  test('a plain member of the other server has no access to it, while administering their own', () => {
    const guilds = [
      guild(GUILD, Permissions.ManageGuild),
      guild(OTHER, Permissions.ViewChannel | Permissions.SendMessages),
    ];

    expect(resolveGuildAccess(guilds, GUILD)).not.toBeNull();
    expect(resolveGuildAccess(guilds, OTHER)).toBeNull();
  });

  test('moderation powers without Manage Server give no access', () => {
    const guilds = [
      guild(OTHER, Permissions.ManageRoles | Permissions.BanMembers | Permissions.ViewChannel),
    ];

    expect(resolveGuildAccess(guilds, OTHER)).toBeNull();
  });

  test('a server missing from the user’s list gives no access, whatever they own elsewhere', () => {
    const guilds = [guild(GUILD, 0n, true), guild('222222222222222222', Permissions.Administrator)];

    expect(resolveGuildAccess(guilds, OTHER)).toBeNull();
    expect(resolveGuildAccess([], OTHER)).toBeNull();
  });

  test('the status server function is a read behind the guild access check', () => {
    const declared = declaration('server/branding.ts', 'getNameStyleStatus', '.handler(');

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('.middleware([requireGuildAccess])');
    expect(declared).toContain('guildId: z.string().min(1)');
    expect(source('server/branding.ts')).toContain(
      "import { requireGuildAccess } from '../middleware/guild-access.ts';",
    );
  });

  test('the guild access check refuses when the path’s server resolves to no access', () => {
    const declared = declaration(
      'middleware/guild-access.ts',
      'requireGuildAccess',
      'export function requirePermission',
    );

    expect(declared).toContain('.middleware([requireSession])');
    expect(declared).toContain('resolveGuildAccess(guilds, data.guildId)');
    expect(declared).toContain('if (!access) throw new ForbiddenError(');
  });

  test('the status query reads through that server function', () => {
    expect(source('lib/queries.ts')).toContain(
      "import { getNameStyleStatus } from '../server/branding.ts';",
    );
  });
});
