import { missing, permissionLabels } from '../permissions/bits.ts';
import type { ActionFailure } from './types.ts';

export interface PrecheckInput {
  guildId: string;
  guildOwnerId: string;
  botUserId: string;
  botHighestRolePosition: number;

  botChannelPermissions: bigint;
  requiredPermissions: bigint;
  channelId?: string;
  channelOverwritesUnknown?: boolean;
  threadParentId?: string;
  role?: { id: string; position: number };
  target?: { id: string; highestRolePosition: number; exemptAsAdministrator?: boolean };

  // Off for a kind Discord does not rank, so the owner and hierarchy gates below are skipped while
  // the target is still resolved for the audit record. See hierarchyApplies.
  hierarchy?: boolean;

  targetIsMember?: boolean;
}

export function whereItIsMissing(input: PrecheckInput): string {
  if (!input.channelId) return 'this server';

  if (input.channelOverwritesUnknown) {
    return (
      `this server. <#${input.channelId}> isn't in Proton's channel list yet, so that ` +
      "channel's own permission overwrites weren't checked"
    );
  }

  if (input.threadParentId) {
    return (
      `<#${input.channelId}>. A thread has no permission overwrites of its own, so grant it in ` +
      `<#${input.threadParentId}> instead`
    );
  }

  return `<#${input.channelId}>`;
}

export function runPrechecks(input: PrecheckInput): ActionFailure | null {
  const lacking = missing(input.botChannelPermissions, input.requiredPermissions);
  if (lacking !== 0n) {
    const labels = permissionLabels(lacking);
    const names = labels.join(', ');
    return {
      code: 'missing_permission',
      humanReason: `Missing the ${names} permission${labels.length === 1 ? '' : 's'} in ${whereItIsMissing(input)}.`,
    };
  }

  if (input.role && input.role.position >= input.botHighestRolePosition) {
    return {
      code: 'role_hierarchy',
      humanReason:
        `The <@&${input.role.id}> role is above or equal to Proton's highest role, so it can't ` +
        "be managed. Move Proton's role above it in Server Settings → Roles.",
    };
  }

  const target = input.target;
  if (!target) return null;

  if (target.id === input.botUserId) {
    return {
      code: 'target_is_self',
      humanReason: "Proton can't do that to itself.",
    };
  }

  // Everything below is Discord's ranking model, which does not reach every kind that names a
  // member. The target is still resolved above, so the action is recorded against the right person.
  if (input.hierarchy === false) return null;

  if (target.id === input.guildOwnerId) {
    return {
      code: 'target_is_owner',
      humanReason: "Discord doesn't allow this on the server owner.",
    };
  }

  if (input.targetIsMember === false) return null;

  if (target.exemptAsAdministrator === true) {
    return {
      code: 'target_is_administrator',
      humanReason:
        "That member has the Administrator permission, and Discord won't let anyone time out an " +
        'Administrator or change their timeout. A timeout has no effect on them while they hold it.',
    };
  }

  if (target.highestRolePosition >= input.botHighestRolePosition) {
    return {
      code: 'role_hierarchy',
      humanReason:
        "That member's highest role is above or equal to Proton's highest role. Move Proton's " +
        'role above theirs in Server Settings → Roles.',
    };
  }

  return null;
}
