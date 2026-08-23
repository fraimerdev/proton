import { missing, permissionNames } from '../permissions/bits.ts';
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
}

function whereItIsMissing(input: PrecheckInput): string {
  if (!input.channelId) return `guild ${input.guildId}`;

  if (input.channelOverwritesUnknown) {
    return (
      `guild ${input.guildId}. I couldn't check channel ${input.channelId} itself — it is not in ` +
      "my cached channel list, so that channel's own permission overwrites were not applied"
    );
  }

  if (input.threadParentId) {
    return (
      `thread ${input.channelId} — a thread has no permission overwrites of its own, so grant it ` +
      `in its parent channel ${input.threadParentId}`
    );
  }

  return `channel ${input.channelId}`;
}

export function runPrechecks(input: PrecheckInput): ActionFailure | null {
  const lacking = missing(input.botChannelPermissions, input.requiredPermissions);
  if (lacking !== 0n) {
    const names = permissionNames(lacking).join(', ');
    return {
      code: 'missing_permission',
      humanReason: `I'm missing the ${names} permission in ${whereItIsMissing(input)}.`,
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
