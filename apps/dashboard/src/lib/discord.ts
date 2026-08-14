import type { DiscordUserGuild } from './guild-access.ts';

/**
 * Fetch the guilds a user belongs to, using *their* OAuth token.
 *
 * Routed through the REST proxy like every other Discord call (I2) — the proxy
 * forwards the supplied Authorization header instead of the bot token. The
 * browser never performs this request; it happens server-side so the guild list
 * cannot be forged (I6).
 */
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

/** Text channels in a guild, for the channel-id field type. */
export async function fetchGuildChannels(
  restProxyUrl: string,
  guildId: string,
): Promise<Array<{ id: string; name: string; type: number }>> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/guilds/${guildId}/channels`);

  if (!response.ok) return [];

  // Note: from 16 Nov 2026 Discord omits channels the bot cannot view from this
  // endpoint entirely, so an admin may see fewer channels here than in their
  // client. That is expected, not a bug.
  return (await response.json()) as Array<{ id: string; name: string; type: number }>;
}
