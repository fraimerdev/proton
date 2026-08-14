import { has, Permissions } from '@proton/core';

/** A guild as Discord returns it from `GET /users/@me/guilds`. */
export interface DiscordUserGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  /** The *user's* permissions in that guild, as a decimal string. */
  permissions: string;
}

export interface GuildAccess {
  guildId: string;
  via: 'owner' | 'manage_guild';
  permissions: bigint;
}

/**
 * Decide whether a user may administer a guild.
 *
 * The guild list is always fetched server-side with the user's own OAuth token
 * (I6) — a guild id arriving from the browser is only ever a lookup key, never
 * evidence of access. Returning null rather than throwing lets callers choose
 * between "not in the picker" and "403".
 */
export function resolveGuildAccess(
  guilds: readonly DiscordUserGuild[],
  guildId: string,
): GuildAccess | null {
  const guild = guilds.find((g) => g.id === guildId);
  if (!guild) return null;

  // Discord sends this as a decimal string precisely because it exceeds 2^53;
  // parsing it as a Number would corrupt the high permission bits.
  const permissions = BigInt(guild.permissions);

  if (guild.owner) return { guildId, via: 'owner', permissions };
  if (has(permissions, Permissions.Administrator)) {
    return { guildId, via: 'manage_guild', permissions };
  }
  if (has(permissions, Permissions.ManageGuild)) {
    return { guildId, via: 'manage_guild', permissions };
  }

  return null;
}

/** Guilds to offer in the picker — those the user can actually administer. */
export function administrableGuilds(guilds: readonly DiscordUserGuild[]): DiscordUserGuild[] {
  return guilds.filter((g) => resolveGuildAccess(guilds, g.id) !== null);
}

/** Does this access grant a specific permission? */
export function accessGrants(access: GuildAccess, required: bigint): boolean {
  if (access.via === 'owner') return true;
  if (has(access.permissions, Permissions.Administrator)) return true;
  return has(access.permissions, required);
}
