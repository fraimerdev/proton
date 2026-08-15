import type { DiscordUserGuild } from './guild-access.ts';

export async function fetchUserGuilds(
  restProxyUrl: string,
  accessToken: string,
): Promise<DiscordUserGuild[]> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/users/@me/guilds`, {
    headers: { 'x-proton-authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`could not load your Discord servers (${response.status})`);
  }

  return (await response.json()) as DiscordUserGuild[];
}

export async function fetchGuildRoles(
  restProxyUrl: string,
  guildId: string,
): Promise<Array<{ id: string; name: string; position: number }>> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/guilds/${guildId}/roles`);

  if (!response.ok) return [];

  const roles = (await response.json()) as Array<{ id: string; name: string; position: number }>;

  return roles
    .filter((role) => role.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({ id: role.id, name: role.name, position: role.position }));
}

export async function fetchGuildChannels(
  restProxyUrl: string,
  guildId: string,
): Promise<Array<{ id: string; name: string; type: number }>> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/guilds/${guildId}/channels`);

  if (!response.ok) return [];

  return (await response.json()) as Array<{ id: string; name: string; type: number }>;
}
