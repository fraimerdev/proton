import type { GuildRole, Overwrite } from '../permissions/compute.ts';

export interface ChannelState {
  id: string;

  parentId: string | null;
  type?: number;

  // Optional because a snapshot written before this field existed has none, and a counter that
  // rewrites a name it cannot read is still correct — only wasteful.
  name?: string;
  overwrites: Overwrite[];
}

export interface GuildState {
  guildId: string;
  ownerId: string;

  everyoneRoleId: string;
  roles: Map<string, GuildRole>;
  botRoleIds: string[];
  channels: Map<string, ChannelState>;

  // Both come from GUILD_CREATE, which is the only dispatch carrying them. Optional because a
  // snapshot written before this field existed has neither, and a welcome message saying
  // "this server" is better than one saying "undefined".
  name?: string;
  memberCount?: number;

  updatedAt: number;
}

export type GuildStatePatch =
  | { kind: 'role.upsert'; role: GuildRole }
  | { kind: 'role.delete'; roleId: string }
  | { kind: 'channel.upsert'; channel: ChannelState }
  | { kind: 'channel.delete'; channelId: string }
  | { kind: 'bot.roles'; roleIds: string[] }
  // GUILD_CREATE's member_count is a point-in-time reading, so joins and leaves nudge it rather
  // than re-fetching. It re-baselines on every reconnect, which is what keeps the drift bounded.
  | { kind: 'member.count'; delta: number };

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
