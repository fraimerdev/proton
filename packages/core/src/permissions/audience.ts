import { has, Permissions } from './bits.ts';
import {
  applyOverwrites,
  computeBasePermissions,
  type GuildRole,
  type Overwrite,
} from './compute.ts';

export interface ChannelAudienceInput {
  roles: ReadonlyMap<string, GuildRole>;
  everyoneRoleId: string;
  ownerId: string;
  overwrites: readonly Overwrite[];
}

export interface ChannelAudience {
  everyone: boolean;
  roleIds: string[];
  administratorRoleIds: string[];
  memberIds: string[];
}

// Not a snowflake and not empty, so it is never the owner and never matches a member overwrite.
const HOLDER = 'proton:audience';

function holderCanView(input: ChannelAudienceInput, roleIds: readonly string[]): boolean {
  const ctx = {
    guildOwnerId: input.ownerId,
    everyoneRoleId: input.everyoneRoleId,
    memberId: HOLDER,
    memberRoleIds: roleIds,
    roles: input.roles,
  };

  return has(
    applyOverwrites(computeBasePermissions(ctx), input.overwrites, ctx),
    Permissions.ViewChannel,
  );
}

function byRank(a: GuildRole, b: GuildRole): number {
  if (a.position !== b.position) return b.position - a.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function channelAudience(input: ChannelAudienceInput): ChannelAudience {
  const viewers: GuildRole[] = [];
  const administrators: GuildRole[] = [];

  for (const role of input.roles.values()) {
    if (role.id === input.everyoneRoleId) continue;

    if (has(role.permissions, Permissions.Administrator)) {
      administrators.push(role);
    } else if (holderCanView(input, [role.id])) {
      viewers.push(role);
    }
  }

  const memberIds = input.overwrites
    .filter((o) => o.type === 1 && has(o.allow, Permissions.ViewChannel))
    .map((o) => o.id);

  return {
    everyone: holderCanView(input, []),
    roleIds: viewers.sort(byRank).map((role) => role.id),
    administratorRoleIds: administrators.sort(byRank).map((role) => role.id),
    memberIds: [...new Set(memberIds)],
  };
}
