import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Permissions } from '@proton/core';
import {
  jobRequestSchema,
  resetRequestSchema,
  rewardRetryRequestSchema,
} from '@proton/module-achievements/view';
import { fetchProtonRolePower } from '../src/lib/discord.ts';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const MODULE_SRC = join(ROOT, '..', '..', 'packages', 'modules', 'achievements', 'src');
const SERVER = 'server/achievements.ts';

const BROWSER_SAFE = new Set([
  'config',
  'triggers',
  'evaluate',
  'validate',
  'presets',
  'placeholders',
  'simulation',
  'view',
]);

const SERVER_ONLY = [
  /^drizzle-orm/,
  /^ioredis/,
  /^@proton\/db/,
  /^discord\.js/,
  /^@proton\/cards$/,
];

const READS = [
  'getAchievementsOverview',
  'getAchievementMember',
  'listAchievementUnlocks',
  'listAchievementRewards',
  'getProtonRolePower',
] as const;

const WRITES = ['retryAchievementRewards', 'resetAchievements', 'requestAchievementJob'] as const;

const GUILD = '100000000000000001';
const BOT = '100000000000000002';
const REQUEST_ID = 'a1b2c3d4e5f60718';

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

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
}

function reachable(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);

    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) queue.push(join(dirname(file), specifier));
      else packages.add(specifier);
    }
  }

  return { files, packages };
}

describe('the achievements server functions', () => {
  test('are exactly the five reads and the three actions', () => {
    const exported = [...source(SERVER).matchAll(/export const (\w+) = createServerFn/g)].map(
      (match) => match[1],
    );

    expect(new Set(exported)).toEqual(new Set([...READS, ...WRITES]));
  });

  test.each([...READS])('%s is a GET behind the guild access check', (name) => {
    const declared = declaration(SERVER, name);

    expect(declared).toContain("createServerFn({ method: 'GET' })");
    expect(declared).toContain('.middleware([requireGuildAccess])');
    expect(declared).not.toContain('requireManageGuild');
    expect(declared).not.toContain('withAudit');
  });

  test.each([...WRITES])(
    '%s is a POST behind Manage Server, stamped for the audit trail',
    (name) => {
      const declared = declaration(SERVER, name);

      expect(declared).toContain("createServerFn({ method: 'POST' })");
      expect(declared).toContain('.middleware([requireManageGuild])');
      expect(declared).not.toContain('requireGuildAccess');
      expect(declared).toContain('withAudit(context.session.user.id, (stamp) =>');
      expect(declared).toContain('...stamp }');
    },
  );

  test('the audit stamp is spread last, so nothing from the browser can stand in for it', () => {
    for (const name of WRITES) {
      const declared = declaration(SERVER, name);
      const body = declared.includes('...data.reset') ? '...data.reset' : '...body';

      expect(declared.indexOf(body)).toBeGreaterThan(-1);
      expect(declared.indexOf(body)).toBeLessThan(declared.indexOf('...stamp'));
    }
  });

  test('the actions validate the view’s request schemas, which require a client request id', () => {
    expect(declaration(SERVER, 'retryAchievementRewards')).toContain(
      '.validator(rewardRetryRequestSchema.extend({ guildId: z.string().min(1) }))',
    );
    expect(declaration(SERVER, 'resetAchievements')).toContain('reset: resetRequestSchema');
    expect(declaration(SERVER, 'requestAchievementJob')).toContain(
      '.validator(jobRequestSchema.extend({ guildId: z.string().min(1) }))',
    );

    const ref = {
      userId: '100000000000000009',
      achievementId: 'chatterbox',
      tierId: 'gold',
      generation: 0,
      rewardKey: 'xp',
    };

    expect(rewardRetryRequestSchema.safeParse({ rewards: [ref] }).success).toBe(false);
    expect(
      resetRequestSchema.safeParse({ scope: 'member_all', userId: '100000000000000009' }).success,
    ).toBe(false);
    expect(
      jobRequestSchema.safeParse({ achievementId: 'chatterbox', job: 'recheck' }).success,
    ).toBe(false);
    expect(
      jobRequestSchema.safeParse({
        requestId: REQUEST_ID,
        achievementId: 'chatterbox',
        job: 'recheck',
      }).success,
    ).toBe(true);
  });

  test('an actor named by the browser is dropped before the stamp is added', () => {
    const parsed = rewardRetryRequestSchema.parse({
      requestId: REQUEST_ID,
      rewards: [
        {
          userId: '100000000000000009',
          achievementId: 'chatterbox',
          tierId: 'gold',
          generation: 0,
          rewardKey: 'xp',
        },
      ],
      actorId: '100000000000000666',
      source: 'dashboard',
    });

    expect(parsed).not.toHaveProperty('actorId');
    expect(parsed).not.toHaveProperty('source');
  });

  test('Proton’s role power is read through the rest-proxy as Proton itself', () => {
    expect(declaration(SERVER, 'getProtonRolePower')).toContain(
      'fetchProtonRolePower(env.REST_PROXY_URL, data.guildId, env.DISCORD_CLIENT_ID)',
    );
  });

  test('the page reads and acts through those server functions, refreshing on settle', () => {
    const queries = source('pages/achievements/queries.ts');

    expect(queries).toContain("from '../../server/achievements.ts'");
    for (const name of [...READS, ...WRITES]) expect(queries).toContain(name);
    expect(queries.match(/onSettled:/g)).toHaveLength(WRITES.length);
  });
});

describe('the badge image routes', () => {
  const upload = source('routes/api/guilds/$guildId/achievement-badges.ts');
  const read = source('routes/api/guilds/$guildId/achievement-badges.$assetId.ts');

  test('both check Manage Server the way every mutation does', () => {
    for (const route of [upload, read]) {
      expect(route).toContain('resolveGuildAccess(guilds, guildId)');
      expect(route).toContain('accessGrants(access, Permissions.ManageGuild)');
      expect(route).toContain('fetchUserGuilds(env.REST_PROXY_URL, token)');
    }
  });

  test('the upload runs the check before the bytes go anywhere, and names the actor from it', () => {
    expect(upload).toContain("createFileRoute('/api/guilds/$guildId/achievement-badges')");
    expect(upload).toContain('PUT: async');
    expect(upload.indexOf('await allow(request, params.guildId)')).toBeLessThan(
      upload.indexOf('api.uploadAchievementBadge('),
    );
    expect(upload).toContain('allowed.actorId');
  });

  test('a read only reaches the api for a well-formed asset id, after the check', () => {
    expect(read).toContain("createFileRoute('/api/guilds/$guildId/achievement-badges/$assetId')");
    expect(read).toContain('GET: async');
    expect(read.indexOf('BADGE_ASSET_ID.test(params.assetId)')).toBeLessThan(
      read.indexOf('await allow(request, params.guildId)'),
    );
    expect(read.indexOf('await allow(request, params.guildId)')).toBeLessThan(
      read.indexOf('api.achievementBadge('),
    );
  });
});

describe('the dashboard’s Achievements imports', () => {
  // The barrel drags ioredis and drizzle into the browser bundle, and nothing looks wrong until hydration fails.
  test('never reach the module barrel', () => {
    const offenders = sources(SRC).filter((file) =>
      /from '@proton\/module-achievements'/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  test('reach only the browser-safe subpaths', () => {
    const reached = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '@proton\/module-achievements\/([^']+)'/g)].map(
        (match) => match[1] ?? '',
      ),
    );

    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((subpath) => !BROWSER_SAFE.has(subpath))).toEqual([]);
  });

  test.each([...BROWSER_SAFE])('the %s subpath pulls in nothing server-only', (subpath) => {
    const { packages } = reachable(join(MODULE_SRC, `${subpath}.ts`));
    const serverOnly = [...packages].filter((name) => SERVER_ONLY.some((rule) => rule.test(name)));

    expect(serverOnly).toEqual([]);
  });
});

describe('Proton’s role power', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function answer(roles: unknown, member: unknown, memberStatus = 200): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/roles')) return Response.json(roles);
      if (url.endsWith(`/members/${BOT}`)) return Response.json(member, { status: memberStatus });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
  }

  const everyone = { id: GUILD, name: '@everyone', position: 0, permissions: '0' };

  test('Manage Roles on one of Proton’s roles, and its highest position', async () => {
    answer(
      [
        everyone,
        { id: '11', name: 'Proton', position: 4, permissions: String(Permissions.ManageRoles) },
        { id: '12', name: 'Helper', position: 7, permissions: '0' },
        { id: '13', name: 'Admin', position: 9, permissions: String(Permissions.Administrator) },
      ],
      { roles: ['11', '12'] },
    );

    expect(await fetchProtonRolePower('http://proxy', GUILD, BOT)).toEqual({
      manageRoles: true,
      highestPosition: 7,
    });
  });

  test('Administrator counts as Manage Roles, and so does @everyone having it', async () => {
    answer(
      [
        everyone,
        { id: '13', name: 'Admin', position: 2, permissions: String(Permissions.Administrator) },
      ],
      { roles: ['13'] },
    );
    expect((await fetchProtonRolePower('http://proxy', GUILD, BOT))?.manageRoles).toBe(true);

    answer([{ ...everyone, permissions: String(Permissions.ManageRoles) }], { roles: [] });
    expect(await fetchProtonRolePower('http://proxy', GUILD, BOT)).toEqual({
      manageRoles: true,
      highestPosition: 0,
    });
  });

  test('no Manage Roles anywhere', async () => {
    answer(
      [
        everyone,
        { id: '11', name: 'Proton', position: 3, permissions: String(Permissions.SendMessages) },
      ],
      { roles: ['11'] },
    );

    expect(await fetchProtonRolePower('http://proxy', GUILD, BOT)).toEqual({
      manageRoles: false,
      highestPosition: 3,
    });
  });

  test('unknown, never guessed, when Discord does not answer', async () => {
    answer([everyone], { message: 'Missing Access' }, 403);
    expect(await fetchProtonRolePower('http://proxy', GUILD, BOT)).toBeNull();

    globalThis.fetch = (async () => {
      throw new Error('proxy down');
    }) as unknown as typeof fetch;
    expect(await fetchProtonRolePower('http://proxy', GUILD, BOT)).toBeNull();
  });
});
