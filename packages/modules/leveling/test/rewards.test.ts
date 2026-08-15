import { describe, expect, test } from 'bun:test';
import type { RoleReward } from '../src/config.ts';
import { planRoleRewards, rewardRoleIds } from '../src/rewards.ts';

const BRONZE = '700000000000000001';
const SILVER = '700000000000000002';
const GOLD = '700000000000000003';

const LADDER: RoleReward[] = [
  { level: 5, roleId: BRONZE },
  { level: 10, roleId: SILVER },
  { level: 20, roleId: GOLD },
];

/**
 * Role rewards are the one part of leveling that changes a member's
 * permissions, so the two modes are pinned in detail.
 *
 * `stack` can only ever add; `replace` is the mode that removes, and every
 * removal is a way to take something away from someone who earned it. The
 * ordering and duplicate cases below are the ones where a plausible
 * implementation quietly does the wrong thing.
 */
describe('planRoleRewards — stack', () => {
  test('grants every rung reached, not just the newest', () => {
    const plan = planRoleRewards({ rewards: LADDER, level: 10, mode: 'stack' });

    expect(plan.grant).toEqual([BRONZE, SILVER]);
    expect(plan.revoke).toEqual([]);
  });

  test('never revokes anything — which is why it is the default', () => {
    const plan = planRoleRewards({ rewards: LADDER, level: 20, mode: 'stack' });

    expect(plan.revoke).toEqual([]);
    expect(plan.grant).toEqual([BRONZE, SILVER, GOLD]);
  });

  test('grants nothing below the first rung', () => {
    expect(planRoleRewards({ rewards: LADDER, level: 4, mode: 'stack' })).toEqual({
      grant: [],
      revoke: [],
    });
  });

  test('a rung is earned at exactly its level, not one above', () => {
    expect(planRoleRewards({ rewards: LADDER, level: 5, mode: 'stack' }).grant).toEqual([BRONZE]);
  });

  /**
   * Granting a role someone already holds is a no-op at Discord, so skipping it
   * is purely about not spending requests through the shared bucket (I2) on a
   * busy guild's level-ups.
   */
  test('skips roles the member already holds when that is known', () => {
    const plan = planRoleRewards({
      rewards: LADDER,
      level: 10,
      mode: 'stack',
      heldRoleIds: [BRONZE],
    });

    expect(plan.grant).toEqual([SILVER]);
  });

  test('grants everything when the held roles are unknown', () => {
    const plan = planRoleRewards({ rewards: LADDER, level: 10, mode: 'stack' });

    expect(plan.grant).toEqual([BRONZE, SILVER]);
  });
});

describe('planRoleRewards — replace', () => {
  test('keeps the newest rung and drops the ones below it', () => {
    const plan = planRoleRewards({
      rewards: LADDER,
      level: 20,
      mode: 'replace',
      heldRoleIds: [BRONZE, SILVER],
    });

    expect(plan.grant).toEqual([GOLD]);
    expect(new Set(plan.revoke)).toEqual(new Set([BRONZE, SILVER]));
  });

  /**
   * Defined against the highest *level*, not the last array entry, so the answer
   * does not depend on the order a guild happened to list its rewards in.
   */
  test('two roles at the same top level are both kept', () => {
    const rewards: RoleReward[] = [
      { level: 5, roleId: BRONZE },
      { level: 10, roleId: SILVER },
      { level: 10, roleId: GOLD },
    ];

    const plan = planRoleRewards({ rewards, level: 10, mode: 'replace', heldRoleIds: [BRONZE] });

    expect(new Set(plan.grant)).toEqual(new Set([SILVER, GOLD]));
    expect(plan.revoke).toEqual([BRONZE]);
  });

  test('the plan does not depend on the order the rewards are listed in', () => {
    const forward = planRoleRewards({ rewards: LADDER, level: 20, mode: 'replace' });
    const reversed = planRoleRewards({
      rewards: [...LADDER].reverse(),
      level: 20,
      mode: 'replace',
    });

    expect(forward).toEqual(reversed);
  });

  /**
   * A remove-then-add pair for the same role would show in the guild's audit log
   * as Proton churning roles for no reason, and briefly strips a permission the
   * member is entitled to.
   */
  test('a role listed at two levels is kept rather than churned', () => {
    const rewards: RoleReward[] = [
      { level: 5, roleId: BRONZE },
      { level: 20, roleId: BRONZE },
    ];

    const plan = planRoleRewards({
      rewards,
      level: 20,
      mode: 'replace',
      heldRoleIds: [BRONZE],
    });

    expect(plan.revoke).toEqual([]);
    expect(plan.grant).toEqual([]);
  });

  test('does not revoke a role the member does not hold', () => {
    const plan = planRoleRewards({
      rewards: LADDER,
      level: 20,
      mode: 'replace',
      heldRoleIds: [SILVER],
    });

    expect(plan.revoke).toEqual([SILVER]);
  });

  test('revokes optimistically when the held roles are unknown', () => {
    const plan = planRoleRewards({ rewards: LADDER, level: 20, mode: 'replace' });

    expect(new Set(plan.revoke)).toEqual(new Set([BRONZE, SILVER]));
  });

  test('grants nothing below the first rung', () => {
    expect(planRoleRewards({ rewards: LADDER, level: 1, mode: 'replace' })).toEqual({
      grant: [],
      revoke: [],
    });
  });
});

describe('rewardRoleIds', () => {
  test('lists every role any rung can grant, once', () => {
    expect(rewardRoleIds([...LADDER, { level: 30, roleId: GOLD }])).toEqual([BRONZE, SILVER, GOLD]);
  });

  test('is empty for an empty ladder', () => {
    expect(rewardRoleIds([])).toEqual([]);
  });
});
