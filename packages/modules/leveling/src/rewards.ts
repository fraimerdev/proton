import type { RewardMode, RoleReward } from './config.ts';

export interface RewardPlan {
  grant: string[];

  revoke: string[];
}

export interface RewardPlanInput {
  rewards: readonly RoleReward[];

  level: number;
  mode: RewardMode;

  heldRoleIds?: readonly string[] | undefined;
}

export function planRoleRewards(input: RewardPlanInput): RewardPlan {
  const earned = input.rewards
    .filter((reward) => reward.level <= input.level)
    .sort((a, b) => a.level - b.level);

  if (earned.length === 0) return { grant: [], revoke: [] };

  const held = input.heldRoleIds ? new Set(input.heldRoleIds) : null;

  if (input.mode === 'stack') {
    return {
      grant: unique(earned.map((reward) => reward.roleId)).filter(missing(held)),
      revoke: [],
    };
  }

  const top = earned[earned.length - 1]?.level ?? 0;
  const keep = unique(earned.filter((reward) => reward.level === top).map((r) => r.roleId));
  const keepSet = new Set(keep);

  const revoke = unique(earned.filter((reward) => reward.level < top).map((r) => r.roleId))

    .filter((roleId) => !keepSet.has(roleId))

    .filter((roleId) => held === null || held.has(roleId));

  return { grant: keep.filter(missing(held)), revoke };
}

export function rewardRoleIds(rewards: readonly RoleReward[]): string[] {
  return unique(rewards.map((reward) => reward.roleId));
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function missing(held: Set<string> | null): (roleId: string) => boolean {
  return (roleId) => held === null || !held.has(roleId);
}
