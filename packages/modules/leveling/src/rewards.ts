import type { RewardMode, RoleReward } from './config.ts';

/**
 * Which reward roles a member should hold at a level.
 *
 * Pure and synchronous — no executor, no guild state — so the `stack` and
 * `replace` rules can be exhaustively tested against plain objects. Everything
 * that follows from the answer (whether the bot is allowed to move those roles,
 * what happens when it is not) belongs to the executor's prechecks (I8), not
 * here.
 *
 * **Why this is module logic and not a rule.** §4-P2 makes preset rules the way
 * a module expresses "when X, do Y", and role rewards look exactly like that
 * shape. They are not expressible in it: the trigger is "the member reached
 * level N", and the rule engine's predicate set is deliberately closed with no
 * numeric comparison in it. Widening it to fit would open the door `antiraid`
 * documents keeping shut — so the mapping stays here, and `xp.level_gained` is
 * still published so a future rule builder can react to the event without this
 * module having to anticipate it (docs/PHASE-3.md §3.D).
 */
export interface RewardPlan {
  /** Roles to add, in ascending level order. */
  grant: string[];
  /** Roles to take away. Always empty in `stack` mode. */
  revoke: string[];
}

export interface RewardPlanInput {
  rewards: readonly RoleReward[];
  /** The level the member has just reached. */
  level: number;
  mode: RewardMode;
  /**
   * The member's current roles, when the event carried them.
   *
   * An optimisation, never a correctness requirement: granting a role someone
   * already holds is a no-op at Discord, so the plan is right either way. When
   * the roles are known it is right in fewer REST calls, which on a busy guild's
   * level-ups is the difference between a handful of requests and a burst
   * through the shared bucket (I2). MESSAGE_CREATE carries `member.roles`;
   * a voice disconnect carries no member object at all, so this is optional
   * rather than required.
   */
  heldRoleIds?: readonly string[] | undefined;
}

export function planRoleRewards(input: RewardPlanInput): RewardPlan {
  const earned = input.rewards
    .filter((reward) => reward.level <= input.level)
    .sort((a, b) => a.level - b.level);

  if (earned.length === 0) return { grant: [], revoke: [] };

  const held = input.heldRoleIds ? new Set(input.heldRoleIds) : null;

  if (input.mode === 'stack') {
    // Everything earned, ever. Nothing is taken away, which is why this is the
    // default: enabling the module can only ever add roles.
    return {
      grant: unique(earned.map((reward) => reward.roleId)).filter(missing(held)),
      revoke: [],
    };
  }

  // `replace` keeps the newest rung and drops the ones below it. Defined against
  // the highest *level*, not the last entry, so a guild that lists two roles at
  // level 10 gets both — and so the answer does not depend on the order the
  // array happens to be in.
  const top = earned[earned.length - 1]?.level ?? 0;
  const keep = unique(earned.filter((reward) => reward.level === top).map((r) => r.roleId));
  const keepSet = new Set(keep);

  const revoke = unique(earned.filter((reward) => reward.level < top).map((r) => r.roleId))
    // A role listed at two levels is kept, not removed and re-added: the member
    // is entitled to it at the higher rung, and a remove/add pair would show up
    // in the audit log as Proton churning roles for no reason.
    .filter((roleId) => !keepSet.has(roleId))
    // Only roles they actually hold, when that is known — a revoke for a role
    // the member never had is a REST call that changes nothing.
    .filter((roleId) => held === null || held.has(roleId));

  return { grant: keep.filter(missing(held)), revoke };
}

/** Every role id any reward can grant — what a dashboard preview needs. */
export function rewardRoleIds(rewards: readonly RoleReward[]): string[] {
  return unique(rewards.map((reward) => reward.roleId));
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function missing(held: Set<string> | null): (roleId: string) => boolean {
  return (roleId) => held === null || !held.has(roleId);
}
