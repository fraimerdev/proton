import { describe, expect, test } from 'bun:test';
import { GuildPurgeRefused } from '@proton/db';
import {
  describeGuild,
  GUILD_KEY_FAMILIES,
  type GuildPurgeDeps,
  guildTableLines,
  operatorName,
  PurgeUsageError,
  parsePurgeArgs,
  runGuildPurge,
  signInLines,
} from '../src/purge.ts';
import { guildCronSchedulerIds } from '../src/rule-runtime.ts';

const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const USER_ID = '400000000000000001';

const server = { noun: 'server', allowForce: true };
const user = { noun: 'user', allowForce: false };

const usage =
  (argv: string[], what = server) =>
  () =>
    parsePurgeArgs(argv, what);

describe('parsePurgeArgs', () => {
  test('a bare id is a dry run', () => {
    expect(parsePurgeArgs([GUILD], server)).toEqual({ id: GUILD, apply: false, force: false });
  });

  test('deleting takes --delete and the id typed a second time', () => {
    expect(parsePurgeArgs([GUILD, '--delete', '--confirm', GUILD], server)).toEqual({
      id: GUILD,
      apply: true,
      force: false,
    });
  });

  test('--delete alone is refused and says what to add', () => {
    expect(usage([GUILD, '--delete'])).toThrow(PurgeUsageError);
    expect(usage([GUILD, '--delete'])).toThrow(`--delete --confirm ${GUILD}`);
  });

  test('a confirmation for a different id deletes nothing', () => {
    expect(usage([GUILD, '--delete', '--confirm', OTHER])).toThrow(/is not 900000000000000001/);
  });

  test('--confirm without --delete is refused rather than read as a dry run', () => {
    expect(usage([GUILD, '--confirm', GUILD])).toThrow(/together with --delete/);
  });

  test('--force is passed through for a server', () => {
    expect(parsePurgeArgs([GUILD, '--delete', '--confirm', GUILD, '--force'], server).force).toBe(
      true,
    );
  });

  test('--force does not exist for a user purge', () => {
    expect(usage([GUILD, '--force'], user)).toThrow(PurgeUsageError);
  });

  test('an id that is not a snowflake is refused', () => {
    expect(usage(['my-server'])).toThrow(/not a Discord server id/);
    expect(usage(['12'], user)).toThrow(/not a Discord user id/);
  });

  test('exactly one id', () => {
    expect(usage([])).toThrow(/exactly one server id/);
    expect(usage([GUILD, OTHER])).toThrow(/exactly one server id/);
  });

  test('an unknown flag is refused, not ignored', () => {
    expect(usage([GUILD, '--yes'])).toThrow(PurgeUsageError);
  });
});

describe('GUILD_KEY_FAMILIES', () => {
  test('every pattern is anchored on the server id, so it cannot reach another server', () => {
    for (const family of GUILD_KEY_FAMILIES) {
      const match = family.match(GUILD);

      expect(match).toMatch(new RegExp(`:${GUILD}(:\\*)?$`));
      expect(family.match(OTHER)).not.toContain(GUILD);
    }
  });

  test('covers the keys Proton writes with no expiry or a long one', () => {
    const matches = GUILD_KEY_FAMILIES.map((family) => family.match(GUILD));

    expect(matches).toEqual(
      expect.arrayContaining([
        `proton:verification:quarantine:${GUILD}:*`,
        `proton:verification:panel:${GUILD}`,
        `proton:honeypot:notice:${GUILD}`,
        `proton:honeypot:stats:${GUILD}:*`,
        `proton:honeypot:caught:${GUILD}:*`,
        `proton:giveaways:dirty:${GUILD}`,
        `proton:joinroles:sync:*:${GUILD}`,
        `proton:layout:${GUILD}`,
      ]),
    );
  });

  test('covers what moderation keeps per server: forms, history, reactions, prompts and DMs', () => {
    const matches = GUILD_KEY_FAMILIES.map((family) => family.match(GUILD));

    expect(matches).toEqual(
      expect.arrayContaining([
        `proton:moderation:draft:${GUILD}:*`,
        `proton:moderation:history:${GUILD}:*`,
        `proton:moderation:reaction:${GUILD}:*`,
        `proton:moderation:prompts:${GUILD}`,
        `proton:moderation:dm:${GUILD}:*`,
      ]),
    );
    expect(
      GUILD_KEY_FAMILIES.filter((family) => family.match(GUILD).startsWith('proton:moderation:'))
        .map((family) => family.db)
        .every((db) => db === 'modules'),
    ).toBe(true);
  });
});

describe('guildCronSchedulerIds', () => {
  test('reads only the id set and keeps the ids filed under the server', async () => {
    const reads: unknown[][] = [];
    const client = {
      zrange: async (...args: unknown[]) => {
        reads.push(args);
        return [
          `${GUILD}:automod:a`,
          `${OTHER}:automod:b`,
          `${GUILD}:leveling:c`,
          `${GUILD}0:automod:d`,
        ];
      },
    };
    const queue = {
      toKey: (type: string) => `bull:proton-rule-cron:${type}`,
      getBackend: () => ({ client: Promise.resolve(client) }),
    };

    expect(await guildCronSchedulerIds(queue as never, GUILD)).toEqual([
      `${GUILD}:automod:a`,
      `${GUILD}:leveling:c`,
    ]);
    expect(reads).toEqual([['bull:proton-rule-cron:repeat', 0, -1]]);
  });
});

function guildDeps(begin: () => Promise<never>): GuildPurgeDeps & { lines: string[] } {
  const lines: string[] = [];
  const unused = () => {
    throw new Error('the purge went past a refusal');
  };

  return {
    handle: { client: { begin } } as never,
    redis: { modules: unused, state: unused, messages: unused } as never,
    cron: { getBackend: unused, toKey: unused, removeJobScheduler: unused },
    operator: 'tester on test-host',
    now: () => new Date('2026-09-18T15:00:00.000Z'),
    print: (line) => lines.push(line),
    lines,
  };
}

describe('runGuildPurge', () => {
  test('the header is printed before the database is touched', async () => {
    const out = guildDeps(async () => {
      out.lines.push('<database>');
      throw new Error('connection refused');
    });

    await expect(runGuildPurge(out, { id: GUILD, apply: false, force: false })).rejects.toThrow(
      'connection refused',
    );

    expect(out.lines).toEqual([
      'Proton server data purge: DRY RUN, nothing will be deleted',
      `  subject:  server ${GUILD}`,
      '  started:  2026-09-18T15:00:00.000Z',
      '  operator: tester on test-host',
      '<database>',
    ]);
  });

  test('a refusal while counting prints REFUSED under the header and exits 2', async () => {
    const out = guildDeps(async () => {
      throw new GuildPurgeRefused('case_notes references cases without ON DELETE CASCADE');
    });

    expect(await runGuildPurge(out, { id: GUILD, apply: true, force: false })).toBe(2);

    expect(out.lines[0]).toBe('Proton server data purge: DELETING');
    expect(out.lines.at(-1)).toBe('REFUSED: case_notes references cases without ON DELETE CASCADE');
  });
});

describe('describeGuild', () => {
  const guild = { id: GUILD, name: 'Tea Club', joinedAt: new Date('2026-09-01T00:00:00.000Z') };

  test('a server Proton left names when it joined and left', () => {
    expect(describeGuild({ ...guild, leftAt: new Date('2026-09-18T12:00:00.000Z') })).toBe(
      '"Tea Club", joined 2026-09-01T00:00:00.000Z, left 2026-09-18T12:00:00.000Z',
    );
  });

  test('a server Proton is still in says so', () => {
    expect(describeGuild({ ...guild, leftAt: null })).toBe(
      '"Tea Club", joined 2026-09-01T00:00:00.000Z, Proton is still in it',
    );
  });

  test('no row at all is said plainly', () => {
    expect(describeGuild(null)).toMatch(/no guilds row/);
  });
});

describe('report lines', () => {
  test('every table is listed with how it goes, then a total', () => {
    const lines = guildTableLines([
      { table: 'guilds', removedBy: 'direct', rows: 1 },
      { table: 'giveaway_entries', removedBy: 'cascade', rows: 12 },
      { table: 'message_logs', removedBy: 'direct', rows: 0 },
    ]);

    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/giveaway_entries\s+12 {2}cascade/);
    expect(lines[2]).toMatch(/message_logs\s+0 {2}direct/);
    expect(lines[3]).toMatch(/total\s+13$/);
  });

  test('sign-in lines give only ids and counts, never the person’s name', () => {
    const lines = signInLines({ users: [{ id: 'u1' }], accounts: 1, sessions: 3 }, USER_ID);

    expect(lines[0]).toBe(`  user u1, Discord account ${USER_ID}`);
    expect(lines.slice(1).map((line) => line.trim().replace(/\s+/g, ' '))).toEqual([
      'user rows 1',
      'account rows 1',
      'session rows 3',
    ]);
  });
});

test('the operator is named with the host, and with the sudo caller when there is one', () => {
  expect(operatorName(undefined)).toMatch(/ on /);
  expect(operatorName('alice-not-the-current-user')).toContain(
    '(via sudo from alice-not-the-current-user)',
  );
});
