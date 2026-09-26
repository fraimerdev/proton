import type { GuildMemberSummary } from '@proton/core';
import type { JoinrolesConfig } from '../config.ts';

export type MemberPlan =
  | { kind: 'self' }
  | { kind: 'excluded' }
  | { kind: 'complete' }
  | { kind: 'pending' }
  | { kind: 'grant'; roleIds: string[] };

export interface SyncPlanInput {
  memberRoleIds: readonly string[];
  botRoleIds: readonly string[];
  excludeRoleIds: ReadonlySet<string>;
  waitForScreening: boolean;
  botUserId: string | undefined;
}

export function syncPlanInput(
  config: Pick<
    JoinrolesConfig,
    'syncExcludeEnabled' | 'syncExcludeRoleIds' | 'grantWhenScreeningPasses'
  >,
  grantable: { memberRoleIds: readonly string[]; botRoleIds: readonly string[] },
  options: { botUserId: string | undefined; canHold: boolean },
): SyncPlanInput {
  return {
    memberRoleIds: grantable.memberRoleIds,
    botRoleIds: grantable.botRoleIds,
    excludeRoleIds: new Set(config.syncExcludeEnabled ? config.syncExcludeRoleIds : []),
    waitForScreening: config.grantWhenScreeningPasses && options.canHold,
    botUserId: options.botUserId,
  };
}

export function planMember(member: GuildMemberSummary, input: SyncPlanInput): MemberPlan {
  if (input.botUserId !== undefined && member.userId === input.botUserId) return { kind: 'self' };

  if (member.roleIds.some((roleId) => input.excludeRoleIds.has(roleId))) {
    return { kind: 'excluded' };
  }

  const held = new Set(member.roleIds);
  const wanted = member.bot ? input.botRoleIds : input.memberRoleIds;
  const missing = wanted.filter((roleId) => !held.has(roleId));

  if (missing.length === 0) return { kind: 'complete' };
  if (member.pending && input.waitForScreening) return { kind: 'pending' };

  return { kind: 'grant', roleIds: missing };
}
