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
  target?: { id: string; highestRolePosition: number };

  // Off for a kind Discord does not rank, so the owner and hierarchy gates below are skipped while
  // the target is still resolved for the audit record. See hierarchyApplies.
  hierarchy?: boolean;
}

function whereItIsMissing(input: PrecheckInput): string {
  if (!input.channelId) return 'this server';

  if (input.channelOverwritesUnknown) {
    return (
      `this server. I couldn't check <#${input.channelId}> itself — it isn't in my channel list ` +
      "yet, so that channel's own permission overwrites weren't taken into account"
    );
  }

  if (input.threadParentId) {
    return (
      `<#${input.channelId}> — a thread has no permission overwrites of its own, so grant it in ` +
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
      humanReason: `I'm missing the ${names} permission${labels.length === 1 ? '' : 's'} in ${whereItIsMissing(input)}.`,
    };
  }

  const target = input.target;
  if (!target) return null;

  if (target.id === input.botUserId) {
    return {
      code: 'target_is_self',
      humanReason: "I can't perform this action on myself.",
    };
  }

  // Everything below is Discord's ranking model, which does not reach every kind that names a
  // member. The target is still resolved above, so the action is recorded against the right person.
  if (input.hierarchy === false) return null;

  if (target.id === input.guildOwnerId) {
    return {
      code: 'target_is_owner',
      humanReason: "I can't perform this action on the server owner — Discord forbids it.",
    };
  }

  if (target.highestRolePosition >= input.botHighestRolePosition) {
    return {
      code: 'role_hierarchy',
      humanReason:
        "That member's highest role is above or equal to mine, so I can't act on them. " +
        'Move my role higher in Server Settings → Roles.',
    };
  }

  return null;
}
