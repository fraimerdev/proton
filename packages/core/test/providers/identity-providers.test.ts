import { describe, expect, test } from 'bun:test';
import {
  nameMatchesProvider,
  notBotProvider,
  notTimedOutProvider,
  roleCountProvider,
} from '../../src/providers/builtins.ts';
import type { MemberContext } from '../../src/providers/types.ts';
import { memberContext, NOW, ROLE_A, ROLE_B } from './harness.ts';

function named(overrides: {
  username?: string | null;
  globalName?: string | null;
  nickname?: string | null;
}): MemberContext {
  const base = memberContext();

  return {
    ...base,
    member: base.member === null ? null : { ...base.member, nickname: overrides.nickname ?? null },
    user: {
      ...base.user,
      username: overrides.username ?? null,
      globalName: overrides.globalName ?? null,
    },
  };
}

describe('core.not_bot', () => {
  test('a human passes', async () => {
    expect((await notBotProvider.evaluate(memberContext(), {})).passed).toBe(true);
  });

  test('a bot fails', async () => {
    const ctx = memberContext();
    const result = await notBotProvider.evaluate({ ...ctx, user: { ...ctx.user, bot: true } }, {});

    expect(result.passed).toBe(false);
    expect(result.indeterminate).toBeUndefined();
  });

  test('the failure says why', () => {
    expect(notBotProvider.describeFailure({}, { passed: false }, 'en-GB')).toContain('Bot');
  });
});

describe('core.not_timed_out', () => {
  function timedOutUntil(until: Date | null, partial = false): MemberContext {
    const base = memberContext();

    return {
      ...base,
      member: base.member === null ? null : { ...base.member, communicationDisabledUntil: until },
      ...(partial ? { partial: true } : {}),
    };
  }

  test('a member with no timeout passes', async () => {
    expect((await notTimedOutProvider.evaluate(timedOutUntil(null), {})).passed).toBe(true);
  });

  test('a member timed out into the future fails', async () => {
    const until = new Date(NOW.getTime() + 60_000);

    expect((await notTimedOutProvider.evaluate(timedOutUntil(until), {})).passed).toBe(false);
  });

  test('an expired timeout passes', async () => {
    const until = new Date(NOW.getTime() - 60_000);

    expect((await notTimedOutProvider.evaluate(timedOutUntil(until), {})).passed).toBe(true);
  });

  // On a partial context a null date means "not carried", so reading it as "not timed out" would
  // let a timed-out member through on any dispatch that omitted the field.
  test('a partial context reports indeterminate rather than passing', async () => {
    const result = await notTimedOutProvider.evaluate(timedOutUntil(null, true), {});

    expect(result.passed).toBe(false);
    expect(result.indeterminate).toBeDefined();
  });

  test('a missing member reports indeterminate', async () => {
    const ctx = memberContext();
    const result = await notTimedOutProvider.evaluate({ ...ctx, member: null }, {});

    expect(result.indeterminate).toBeDefined();
  });
});

describe('core.role_count', () => {
  function holding(roleIds: string[]): MemberContext {
    const base = memberContext();
    return { ...base, member: base.member === null ? null : { ...base.member, roleIds } };
  }

  test('enough roles passes and reports progress', async () => {
    const result = await roleCountProvider.evaluate(holding([ROLE_A, ROLE_B]), { min: 2 });

    expect(result.passed).toBe(true);
    expect(result.progress).toEqual({ current: 2, required: 2, unit: 'roles' });
  });

  test('too few roles fails and says how many are held', async () => {
    const result = await roleCountProvider.evaluate(holding([ROLE_A]), { min: 3 });

    expect(result.passed).toBe(false);
    expect(roleCountProvider.describeFailure({ min: 3 }, result, 'en-GB')).toContain('1 role');
  });

  test('duplicate roles are not counted twice', async () => {
    const result = await roleCountProvider.evaluate(holding([ROLE_A, ROLE_A]), { min: 2 });

    expect(result.passed).toBe(false);
  });

  test('a minimum of zero passes for somebody with no roles', async () => {
    expect((await roleCountProvider.evaluate(holding([]), { min: 0 })).passed).toBe(true);
  });

  test('roles that were not carried report indeterminate, not zero', async () => {
    const base = memberContext();
    const ctx = {
      ...base,
      member: base.member === null ? null : { ...base.member, roleIds: null },
    };

    const result = await roleCountProvider.evaluate(ctx, { min: 1 });

    expect(result.indeterminate).toBeDefined();
  });
});

describe('core.name_matches', () => {
  const config = { mode: 'contains', value: 'proton', field: 'any' } as const;

  test.each([
    ['contains', 'xxprotonxx', true],
    ['contains', 'nothing', false],
    ['starts-with', 'protonaut', true],
    ['starts-with', 'aproton', false],
    ['ends-with', 'theproton', true],
    ['ends-with', 'protonx', false],
    ['equals', 'proton', true],
    ['equals', 'proton ', false],
  ] as const)('%s against %s is %s', async (mode, username, expected) => {
    const result = await nameMatchesProvider.evaluate(named({ username }), {
      ...config,
      mode,
    });

    expect(result.passed).toBe(expected);
  });

  test('matching is case-insensitive', async () => {
    const result = await nameMatchesProvider.evaluate(named({ username: 'PROTON' }), config);

    expect(result.passed).toBe(true);
  });

  test('“any” checks username, display name and nickname', async () => {
    expect((await nameMatchesProvider.evaluate(named({ nickname: 'proton' }), config)).passed).toBe(
      true,
    );
    expect(
      (await nameMatchesProvider.evaluate(named({ globalName: 'proton' }), config)).passed,
    ).toBe(true);
  });

  test('a specific field ignores the others', async () => {
    const result = await nameMatchesProvider.evaluate(named({ nickname: 'proton' }), {
      ...config,
      field: 'username',
    });

    expect(result.passed).toBe(false);
  });

  // A payload that carried no names must not match against an empty string, which would fail
  // "contains" closed and pass "equals ''" open.
  test('no names at all reports indeterminate rather than matching', async () => {
    const result = await nameMatchesProvider.evaluate(named({}), config);

    expect(result.passed).toBe(false);
    expect(result.indeterminate).toBeDefined();
  });

  test('the description names the field and the text', () => {
    expect(nameMatchesProvider.describe({ ...config, field: 'nickname' }, 'en-GB')).toContain(
      'nickname',
    );
    expect(nameMatchesProvider.describe(config, 'en-GB')).toContain('proton');
  });

  test('regex metacharacters are matched literally, not compiled', async () => {
    const result = await nameMatchesProvider.evaluate(named({ username: 'aaaa' }), {
      ...config,
      value: '(a+)+$',
    });

    expect(result.passed).toBe(false);
  });
});
