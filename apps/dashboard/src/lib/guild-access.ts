import { has, Permissions } from '@proton/core';

export interface DiscordUserGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;

  permissions: string;
}

export interface GuildAccess {
  guildId: string;
  via: 'owner' | 'manage_guild';
  permissions: bigint;
}

export function resolveGuildAccess(
  guilds: readonly DiscordUserGuild[],
  guildId: string,
): GuildAccess | null {
  const guild = guilds.find((g) => g.id === guildId);
  if (!guild) return null;

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

export interface AdministrableGuild extends DiscordUserGuild {
  joined: boolean;
}

export function administrableGuilds(guilds: readonly DiscordUserGuild[]): DiscordUserGuild[] {
  return guilds.filter((g) => resolveGuildAccess(guilds, g.id) !== null);
}

// The OAuth guild list says what the user administers and nothing about where Proton is. The
// picker used to present the two as the same thing, so `joined` has to come from elsewhere.
export function withPresence(
  guilds: readonly DiscordUserGuild[],
  present: ReadonlySet<string>,
): AdministrableGuild[] {
  return guilds.map((g) => ({ ...g, joined: present.has(g.id) }));
}

export function accessGrants(access: GuildAccess, required: bigint): boolean {
  if (access.via === 'owner') return true;
  if (has(access.permissions, Permissions.Administrator)) return true;
  return has(access.permissions, required);
}
