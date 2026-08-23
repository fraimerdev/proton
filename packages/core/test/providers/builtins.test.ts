import { describe, expect, test } from 'bun:test';
import {
  accountAgeProvider,
  hasAvatarProvider,
  hasRoleProvider,
  isBoosterProvider,
  isPremiumProvider,
  lacksRoleProvider,
  memberAgeProvider,
} from '../../src/providers/builtins.ts';
import { evaluateFactCondition } from '../../src/rules/conditions.ts';
import type { RuleFacts } from '../../src/rules/facts.ts';
import { memberContext, NOW, ROLE_A, ROLE_B, userIdAt } from './harness.ts';

const OTHER_ROLE = '600000000000000009';

describe('core.has_role', () => {
  test('any mode passes when one of the roles is held', async () => {
    const ctx = memberContext({ member: { roleIds: [ROLE_B] } as never });
    const result = await hasRoleProvider.evaluate(ctx, { roleIds: [ROLE_A, ROLE_B], mode: 'any' });

    expect(result.passed).toBe(true);
  });

  test('any mode fails when none are held', async () => {
    const ctx = memberContext({ member: { roleIds: [OTHER_ROLE] } as never });
    const result = await hasRoleProvider.evaluate(ctx, { roleIds: [ROLE_A, ROLE_B], mode: 'any' });

    expect(result.passed).toBe(false);
    expect(result.indeterminate).toBeUndefined();
  });

  test('all mode requires every role', async () => {
    const partial = memberContext({ member: { roleIds: [ROLE_A] } as never });
    const complete = memberContext({ member: { roleIds: [ROLE_A, ROLE_B] } as never });
    const config = { roleIds: [ROLE_A, ROLE_B], mode: 'all' as const };

    expect((await hasRoleProvider.evaluate(partial, config)).passed).toBe(false);
    expect((await hasRoleProvider.evaluate(complete, config)).passed).toBe(true);
  });

  test('unknown roles are indeterminate, never a plain no', async () => {
    const ctx = memberContext({ member: { roleIds: null } as never });
    const result = await hasRoleProvider.evaluate(ctx, { roleIds: [ROLE_A], mode: 'any' });

    expect(result.passed).toBe(false);
    expect(result.indeterminate?.humanReason).toContain('Server Members intent');
  });

  test('an absent member is indeterminate', async () => {
    const result = await hasRoleProvider.evaluate(memberContext({ member: null }), {
      roleIds: [ROLE_A],
      mode: 'any',
    });

    expect(result.indeterminate).toBeDefined();
  });

  test('the failure line names the roles the member needs', async () => {
    const ctx = memberContext({ member: { roleIds: [] } as never });
    const config = { roleIds: [ROLE_A], mode: 'any' as const };
    const result = await hasRoleProvider.evaluate(ctx, config);

    expect(hasRoleProvider.describeFailure(config, result, 'en')).toContain(`<@&${ROLE_A}>`);
  });
});

describe('core.lacks_role', () => {
  test('is the negation of has_role in any mode', async () => {
    const ctx = memberContext({ member: { roleIds: [ROLE_A] } as never });
    const config = { roleIds: [ROLE_A, ROLE_B], mode: 'any' as const };

    const has = await hasRoleProvider.evaluate(ctx, config);
    const lacks = await lacksRoleProvider.evaluate(ctx, config);

    expect(lacks.passed).toBe(!has.passed);
  });

  test('is the negation of has_role in all mode', async () => {
    const ctx = memberContext({ member: { roleIds: [ROLE_A, ROLE_B] } as never });
    const config = { roleIds: [ROLE_A, ROLE_B], mode: 'all' as const };

    const has = await hasRoleProvider.evaluate(ctx, config);
    const lacks = await lacksRoleProvider.evaluate(ctx, config);

    expect(lacks.passed).toBe(!has.passed);
  });

  test('unknown roles fail closed with an explanation rather than passing', async () => {
    const ctx = memberContext({ member: { roleIds: null } as never });
    const result = await lacksRoleProvider.evaluate(ctx, { roleIds: [ROLE_A], mode: 'any' });

    expect(result.passed).toBe(false);
    expect(result.indeterminate).toBeDefined();
  });
});

describe('core.account_age', () => {
  const old = memberContext({
    user: { createdAt: new Date('2019-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
  });
  const fresh = memberContext({
    user: { createdAt: new Date('2026-08-13T12:00:00.000Z'), hasAvatar: true, bot: false },
  });

  test('older-than passes for an old account and fails for a new one', async () => {
    const config = { operator: 'older-than' as const, duration: '30d' };

    expect((await accountAgeProvider.evaluate(old, config)).passed).toBe(true);
    expect((await accountAgeProvider.evaluate(fresh, config)).passed).toBe(false);
  });

  test('younger-than is the mirror image', async () => {
    const config = { operator: 'younger-than' as const, duration: '30d' };

    expect((await accountAgeProvider.evaluate(old, config)).passed).toBe(false);
    expect((await accountAgeProvider.evaluate(fresh, config)).passed).toBe(true);
  });

  test('an unreadable duration is indeterminate, not a refusal', async () => {
    const result = await accountAgeProvider.evaluate(old, {
      operator: 'older-than',
      duration: 'a fortnight',
    });

    expect(result.indeterminate).toBeDefined();
  });

  test('progress carries the real age so the failure line can quote it', async () => {
    const config = { operator: 'older-than' as const, duration: '365d' };
    const result = await accountAgeProvider.evaluate(fresh, config);

    expect(result.progress?.current).toBe(NOW.getTime() - fresh.user.createdAt.getTime());
    expect(accountAgeProvider.describeFailure(config, result, 'en')).toContain('365d');
  });
});

describe('core.member_age', () => {
  test('measures time since joining this server, not account age', async () => {
    const ctx = memberContext({
      member: {
        joinedAt: new Date('2026-08-13T12:00:00.000Z'),
        roleIds: [],
        premiumSince: null,
        communicationDisabledUntil: null,
      },
      user: { createdAt: new Date('2015-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    });

    expect(
      (await memberAgeProvider.evaluate(ctx, { operator: 'older-than', duration: '30d' })).passed,
    ).toBe(false);
  });

  test('an unknown join date is indeterminate', async () => {
    const ctx = memberContext({
      member: {
        joinedAt: null,
        roleIds: [],
        premiumSince: null,
        communicationDisabledUntil: null,
      },
    });

    const result = await memberAgeProvider.evaluate(ctx, {
      operator: 'older-than',
      duration: '30d',
    });

    expect(result.indeterminate).toBeDefined();
  });
});

describe('core.is_booster and core.has_avatar', () => {
  test('is_booster reads premiumSince', async () => {
    const boosting = memberContext({
      member: {
        joinedAt: null,
        roleIds: [],
        premiumSince: new Date('2026-01-01'),
        communicationDisabledUntil: null,
      },
    });

    expect((await isBoosterProvider.evaluate(boosting, {})).passed).toBe(true);
    expect((await isBoosterProvider.evaluate(memberContext(), {})).passed).toBe(false);
  });

  test('has_avatar is indeterminate when the avatar could not be read', async () => {
    const unknown = memberContext({
      user: { createdAt: new Date('2020-01-01'), hasAvatar: null, bot: false },
    });

    expect((await hasAvatarProvider.evaluate(unknown, {})).indeterminate).toBeDefined();
  });

  test('has_avatar passes only with an avatar set', async () => {
    const without = memberContext({
      user: { createdAt: new Date('2020-01-01'), hasAvatar: false, bot: false },
    });

    expect((await hasAvatarProvider.evaluate(memberContext(), {})).passed).toBe(true);
    expect((await hasAvatarProvider.evaluate(without, {})).passed).toBe(false);
  });
});

describe('core.is_premium', () => {
  test('compares the guild tier against the required one', async () => {
    const pro = memberContext({ tier: 'pro' });

    expect((await isPremiumProvider.evaluate(pro, { tier: 'plus' })).passed).toBe(true);
    expect((await isPremiumProvider.evaluate(memberContext(), { tier: 'plus' })).passed).toBe(
      false,
    );
  });
});

// The point of the migration: a provider must judge exactly what the rule-engine condition it
// replaces judged, or a guild's existing automod rules quietly change behaviour on deploy.
describe('parity with the rule-engine conditions they replace', () => {
  const now = NOW.getTime();

  function facts(overrides: Partial<RuleFacts> = {}): RuleFacts {
    return { actorId: userIdAt(new Date('2020-01-01T00:00:00.000Z')), ...overrides };
  }

  const roleCases: { held: string[] | undefined; ids: string[]; match: 'any' | 'all' }[] = [
    { held: [ROLE_A], ids: [ROLE_A], match: 'any' },
    { held: [ROLE_A], ids: [ROLE_A, ROLE_B], match: 'any' },
    { held: [ROLE_A], ids: [ROLE_A, ROLE_B], match: 'all' },
    { held: [ROLE_A, ROLE_B], ids: [ROLE_A, ROLE_B], match: 'all' },
    { held: [], ids: [ROLE_A], match: 'any' },
    { held: [OTHER_ROLE], ids: [ROLE_A], match: 'any' },
  ];

  test('core.has_role agrees with role-has on every combination', async () => {
    for (const testCase of roleCases) {
      const legacy = evaluateFactCondition(
        { kind: 'role-has', roleIds: testCase.ids, match: testCase.match },
        facts(testCase.held === undefined ? {} : { roleIds: testCase.held }),
        now,
      );

      const ctx = memberContext({ member: { roleIds: testCase.held ?? null } as never });
      const provider = await hasRoleProvider.evaluate(ctx, {
        roleIds: testCase.ids,
        mode: testCase.match,
      });

      expect(provider.passed).toBe(legacy.passed);
    }
  });

  test('core.lacks_role agrees with role-lacks on every combination', async () => {
    for (const testCase of roleCases) {
      const legacy = evaluateFactCondition(
        { kind: 'role-lacks', roleIds: testCase.ids, match: testCase.match },
        facts(testCase.held === undefined ? {} : { roleIds: testCase.held }),
        now,
      );

      const ctx = memberContext({ member: { roleIds: testCase.held ?? null } as never });
      const provider = await lacksRoleProvider.evaluate(ctx, {
        roleIds: testCase.ids,
        mode: testCase.match,
      });

      expect(provider.passed).toBe(legacy.passed);
    }
  });

  test('core.account_age agrees with account-age either side of the threshold', async () => {
    for (const operator of ['older-than', 'younger-than'] as const) {
      for (const createdAt of ['2019-01-01T00:00:00.000Z', '2026-08-13T00:00:00.000Z']) {
        const created = new Date(createdAt);

        const legacy = evaluateFactCondition(
          { kind: 'account-age', operator, duration: '30d' },
          facts({ accountCreatedAt: created.getTime() }),
          now,
        );

        const ctx = memberContext({
          user: { createdAt: created, hasAvatar: true, bot: false },
        });
        const provider = await accountAgeProvider.evaluate(ctx, { operator, duration: '30d' });

        expect(provider.passed).toBe(legacy.passed);
      }
    }
  });

  test('core.is_premium agrees with is-premium across every tier pair', async () => {
    for (const actual of ['free', 'plus', 'pro'] as const) {
      for (const required of ['free', 'plus', 'pro'] as const) {
        const legacy = evaluateFactCondition(
          { kind: 'is-premium', tier: required },
          facts({ entitlement: actual }),
          now,
        );

        const provider = await isPremiumProvider.evaluate(memberContext({ tier: actual }), {
          tier: required,
        });

        expect(provider.passed).toBe(legacy.passed);
      }
    }
  });
});
