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
  target?: { id: string; highestRolePosition: number };
}

export function runPrechecks(input: PrecheckInput): ActionFailure | null {
  const lacking = missing(input.botChannelPermissions, input.requiredPermissions);
  if (lacking !== 0n) {
    const names = permissionNames(lacking).join(', ');
    const where = input.channelId ? `channel ${input.channelId}` : `guild ${input.guildId}`;
    return {
      code: 'missing_permission',
      humanReason: `I'm missing the ${names} permission in ${where}.`,
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
