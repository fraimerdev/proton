import { describe, expect, test } from 'bun:test';
import {
  absentMemberContext,
  memberContextFromGuildMember,
  memberContextFromRuleFacts,
  StaticMemberContextLoader,
} from '../../src/providers/member-context.ts';
import { GUILD, memberContext, NOW, ROLE_A, USER_A, USER_B } from './harness.ts';

describe('memberContextFromRuleFacts', () => {
  test('carries the roles the dispatch supplied', () => {
    const ctx = memberContextFromRuleFacts(GUILD, { actorId: USER_A, roleIds: [ROLE_A] }, NOW);

    expect(ctx?.member?.roleIds).toEqual([ROLE_A]);
    expect(ctx?.userId).toBe(USER_A);
  });

  test('leaves roles unknown rather than empty when the facts carried none', () => {
    const ctx = memberContextFromRuleFacts(GUILD, { actorId: USER_A }, NOW);

    expect(ctx?.member?.roleIds).toBeNull();
  });

  test('leaves the join date, boost date and timeout unknown', () => {
    const ctx = memberContextFromRuleFacts(GUILD, { actorId: USER_A, roleIds: [] }, NOW);

    expect(ctx?.member?.joinedAt).toBeNull();
    expect(ctx?.member?.premiumSince).toBeNull();
    expect(ctx?.member?.communicationDisabledUntil).toBeNull();
  });

  test('derives the account creation date from the snowflake when the facts omit it', () => {
    const ctx = memberContextFromRuleFacts(GUILD, { actorId: USER_A }, NOW);

    expect(ctx?.user.createdAt.getUTCFullYear()).toBe(2020);
  });

  test('prefers an explicit accountCreatedAt over the snowflake', () => {
    const explicit = Date.parse('2017-05-05T00:00:00.000Z');
    const ctx = memberContextFromRuleFacts(
      GUILD,
      { actorId: USER_A, accountCreatedAt: explicit },
      NOW,
    );

    expect(ctx?.user.createdAt.getTime()).toBe(explicit);
  });

  test('carries the guild tier through so is_premium can read it', () => {
    const ctx = memberContextFromRuleFacts(GUILD, { actorId: USER_A, entitlement: 'pro' }, NOW);

    expect(ctx?.tier).toBe('pro');
  });

  test('an event with no actor yields no context at all', () => {
    expect(memberContextFromRuleFacts(GUILD, {}, NOW)).toBeNull();
  });
});

describe('memberContextFromGuildMember', () => {
  const raw = {
    joined_at: '2024-03-01T00:00:00.000Z',
    roles: [ROLE_A, 12345, null],
    premium_since: '2026-01-01T00:00:00.000Z',
    communication_disabled_until: null,
    user: { id: USER_A, avatar: 'abc123', bot: false },
  };

  test('reads the member payload Discord actually sends', () => {
    const ctx = memberContextFromGuildMember(GUILD, raw, NOW);

    expect(ctx?.member?.joinedAt?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(ctx?.member?.premiumSince?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(ctx?.user.hasAvatar).toBe(true);
  });

  test('drops role entries that are not snowflake strings', () => {
    expect(memberContextFromGuildMember(GUILD, raw, NOW)?.member?.roleIds).toEqual([ROLE_A]);
  });

  test('an absent avatar is false, not unknown', () => {
    const ctx = memberContextFromGuildMember(
      GUILD,
      { ...raw, user: { id: USER_A, avatar: null, bot: false } },
      NOW,
    );

    expect(ctx?.user.hasAvatar).toBe(false);
  });

  test('a payload with no user is not a context', () => {
    expect(memberContextFromGuildMember(GUILD, { roles: [] }, NOW)).toBeNull();
    expect(memberContextFromGuildMember(GUILD, null, NOW)).toBeNull();
  });

  test('an unreadable timestamp is null rather than an invalid date', () => {
    const ctx = memberContextFromGuildMember(GUILD, { ...raw, joined_at: 'never' }, NOW);

    expect(ctx?.member?.joinedAt).toBeNull();
  });
});

describe('absentMemberContext', () => {
  test('models a member who is no longer in the guild', () => {
    const ctx = absentMemberContext(GUILD, USER_A, NOW);

    expect(ctx?.member).toBeNull();
    expect(ctx?.userId).toBe(USER_A);
  });

  test('a non-snowflake id yields no context', () => {
    expect(absentMemberContext(GUILD, 'not-a-snowflake', NOW)).toBeNull();
  });
});

describe('StaticMemberContextLoader', () => {
  test('returns known contexts and models the rest as departed members', async () => {
    const loader = new StaticMemberContextLoader([memberContext({ userId: USER_A })]);
    const loaded = await loader.load(GUILD, [USER_A, USER_B]);

    expect(loaded.get(USER_A)?.member).not.toBeNull();
    expect(loaded.get(USER_B)?.member).toBeNull();
  });
});
