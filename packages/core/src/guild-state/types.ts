import type { GuildRole, Overwrite } from '../permissions/compute.ts';

export interface ChannelState {
  id: string;
  /** Category, for permission inheritance on synced channels. */
  parentId: string | null;
  overwrites: Overwrite[];
}

/**
 * The slice of guild state prechecks need.
 *
 * Deliberately not "everything about a guild" — only what I8 must decide on:
 * who owns the guild, where every role sits, which roles the bot holds, and the
 * overwrites on each channel.
 */
export interface GuildState {
  guildId: string;
  ownerId: string;
  /** The @everyone role id equals the guild id on Discord. */
  everyoneRoleId: string;
  roles: Map<string, GuildRole>;
  botRoleIds: string[];
  channels: Map<string, ChannelState>;
  /** When this snapshot was built, for staleness diagnostics. */
  updatedAt: number;
}

export type GuildStatePatch =
  | { kind: 'role.upsert'; role: GuildRole }
  | { kind: 'role.delete'; roleId: string }
  | { kind: 'channel.upsert'; channel: ChannelState }
  | { kind: 'channel.delete'; channelId: string }
  | { kind: 'bot.roles'; roleIds: string[] };

/**
 * Guild state storage.
 *
 * PLAN.md §10.4 is explicit that Request Guild Members (all-members form) is
 * capped at 1 per guild per 30 seconds and must never be brute-forced. So this
 * is populated once from GUILD_CREATE and then kept current incrementally from
 * GUILD_ROLE_*, CHANNEL_* and GUILD_MEMBER_UPDATE — never by re-fetching.
 */
export interface GuildStateStore {
  get(guildId: string): Promise<GuildState | null>;
  put(state: GuildState): Promise<void>;
  patch(guildId: string, patch: GuildStatePatch): Promise<void>;
  delete(guildId: string): Promise<void>;
}

/** Highest role position the given roles confer. */
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
