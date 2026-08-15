import type { GuildRole, Overwrite } from '../permissions/compute.ts';

export interface ChannelState {
  id: string;

  parentId: string | null;
  overwrites: Overwrite[];
}

export interface GuildState {
  guildId: string;
  ownerId: string;

  everyoneRoleId: string;
  roles: Map<string, GuildRole>;
  botRoleIds: string[];
  channels: Map<string, ChannelState>;

  updatedAt: number;
}

export type GuildStatePatch =
  | { kind: 'role.upsert'; role: GuildRole }
  | { kind: 'role.delete'; roleId: string }
  | { kind: 'channel.upsert'; channel: ChannelState }
  | { kind: 'channel.delete'; channelId: string }
  | { kind: 'bot.roles'; roleIds: string[] };

export interface GuildStateStore {
  get(guildId: string): Promise<GuildState | null>;
  put(state: GuildState): Promise<void>;
  patch(guildId: string, patch: GuildStatePatch): Promise<void>;
  delete(guildId: string): Promise<void>;
}

export function highestRolePosition(
  roles: ReadonlyMap<string, GuildRole>,
  roleIds: readonly string[],
): number {
  let highest = 0;
  for (const roleId of roleIds) {
    const role = roles.get(roleId);
    if (role && role.position > highest) highest = role.position;
  }
  return highest;
}
