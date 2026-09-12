import { has, Permissions } from '@proton/core';

export interface DiscordUserGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;

  permissions: string;
}

export interface SessionGuild extends DiscordUserGuild {
  present: boolean;
}

// Discord only serves powers of two, and asks for the nearest one up rather than resampling: 64
// is right for the switcher's 22px crest and the emoji picker's 20px one, and blurs into mush
// behind the server picker's 72px crest.
export function guildIconUrl(guild: DiscordUserGuild, size: 64 | 256 = 64): string | null {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=${size}`
    : null;
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

export function administrableGuilds(guilds: readonly DiscordUserGuild[]): DiscordUserGuild[] {
  return guilds.filter((g) => resolveGuildAccess(guilds, g.id) !== null);
}

export function withPresence(
  guilds: readonly DiscordUserGuild[],
  present: ReadonlySet<string>,
): SessionGuild[] {
  return guilds
    .map((guild) => ({ ...guild, present: present.has(guild.id) }))
    .sort((a, b) => Number(b.present) - Number(a.present));
}

export function accessGrants(access: GuildAccess, required: bigint): boolean {
  if (access.via === 'owner') return true;
  if (has(access.permissions, Permissions.Administrator)) return true;
  return has(access.permissions, required);
}
