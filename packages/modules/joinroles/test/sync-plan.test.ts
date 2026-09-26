import { describe, expect, test } from 'bun:test';
import { planMember, type SyncPlanInput, syncPlanInput } from '../src/sync/plan.ts';
import { BOT_ROLE, config, PROTON, ROLE_LOW, ROLE_MID } from './harness.ts';
import { summary, user } from './sync-harness.ts';

function input(overrides: Partial<SyncPlanInput> = {}): SyncPlanInput {
  return {
    memberRoleIds: [ROLE_LOW, ROLE_MID],
    botRoleIds: [BOT_ROLE],
    excludeRoleIds: new Set(),
    waitForScreening: true,
    botUserId: PROTON,
    ...overrides,
  };
}

describe('planMember', () => {
  test('Proton itself is left out and not counted', () => {
    expect(planMember(summary(PROTON), input())).toEqual({ kind: 'self' });
  });

  test('a skip role wins over everything, Membership Screening included', () => {
    const skipped = input({ excludeRoleIds: new Set([ROLE_MID]) });

    expect(planMember(summary(user(1), [ROLE_MID], { pending: true }), skipped)).toEqual({
      kind: 'excluded',
    });
  });

  test('a member in Membership Screening is held only while the wait is on', () => {
    const screenee = summary(user(1), [], { pending: true });

    expect(planMember(screenee, input())).toEqual({ kind: 'pending' });
    expect(planMember(screenee, input({ waitForScreening: false }))).toEqual({
      kind: 'grant',
      roleIds: [ROLE_LOW, ROLE_MID],
    });
  });

  test('a member in Membership Screening who already has every role is complete', () => {
    expect(planMember(summary(user(1), [ROLE_LOW, ROLE_MID], { pending: true }), input())).toEqual({
      kind: 'complete',
    });
  });

  test('bots get the bot roles and members the member roles, only the ones missing', () => {
    expect(planMember(summary(user(1), [], { bot: true }), input())).toEqual({
      kind: 'grant',
      roleIds: [BOT_ROLE],
    });
    expect(planMember(summary(user(2), [ROLE_LOW]), input())).toEqual({
      kind: 'grant',
      roleIds: [ROLE_MID],
    });
    expect(planMember(summary(user(3), [], { bot: true }), input({ botRoleIds: [] }))).toEqual({
      kind: 'complete',
    });
  });
});

describe('syncPlanInput', () => {
  const grantable = { memberRoleIds: [ROLE_LOW], botRoleIds: [] };

  test('skip roles are ignored while the switch is off', () => {
    const off = syncPlanInput(
      config({ syncExcludeEnabled: false, syncExcludeRoleIds: [ROLE_MID] }),
      grantable,
      { botUserId: PROTON, canHold: true },
    );

    expect(off.excludeRoleIds.size).toBe(0);
    expect(planMember(summary(user(1), [ROLE_MID]), off)).toEqual({
      kind: 'grant',
      roleIds: [ROLE_LOW],
    });
  });

  test('skip roles apply while the switch is on', () => {
    const on = syncPlanInput(
      config({ syncExcludeEnabled: true, syncExcludeRoleIds: [ROLE_MID] }),
      grantable,
      { botUserId: PROTON, canHold: true },
    );

    expect(planMember(summary(user(1), [ROLE_MID]), on)).toEqual({ kind: 'excluded' });
  });

  test('with nowhere to hold a screenee, the wait falls through to a grant', () => {
    const unwired = syncPlanInput(config(), grantable, { botUserId: PROTON, canHold: false });

    expect(unwired.waitForScreening).toBe(false);
  });
});
