import type { DiscordUserGuild } from './guild-access.ts';

const inFlight = new Map<string, Promise<DiscordUserGuild[]>>();

// Every server function behind requireGuildAccess re-asks Discord which servers you administer, and
// one page load fires five at once. Overlapping callers share the request already on the wire; the
// entry goes as soon as it settles, so an authorisation question is never answered from a stale list.
export function fetchUserGuilds(
  restProxyUrl: string,
  accessToken: string,
): Promise<DiscordUserGuild[]> {
  const pending = inFlight.get(accessToken);
  if (pending) return pending;

  const request = requestUserGuilds(restProxyUrl, accessToken).finally(() => {
    inFlight.delete(accessToken);
  });

  inFlight.set(accessToken, request);

  return request;
}

async function requestUserGuilds(
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
): Promise<Array<{ id: string; name: string; position: number; color: number }>> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/guilds/${guildId}/roles`);

  if (!response.ok) throw unreadable('roles', guildId, response.status);

  const roles = (await response.json()) as Array<{
    id: string;
    name: string;
    position: number;
    color?: number;
  }>;

  return roles
    .filter((role) => role.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.color ?? 0,
    }));
}

const CATEGORY_TYPE = 4;

export interface GuildChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  parentName: string | null;
}

export async function fetchGuildChannels(
  restProxyUrl: string,
  guildId: string,
): Promise<GuildChannel[]> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/guilds/${guildId}/channels`);

  if (!response.ok) throw unreadable('channels', guildId, response.status);

  const channels = (await response.json()) as Array<{
    id: string;
    name: string;
    type: number;
    position?: number;
    parent_id?: string | null;
  }>;

  const categories = new Map(
    channels.filter((c) => c.type === CATEGORY_TYPE).map((c) => [c.id, c]),
  );

  const rank = (channel: (typeof channels)[number]): [number, number] => {
    const parent = channel.parent_id === null ? undefined : categories.get(channel.parent_id ?? '');

    // Uncategorised channels sit above every category in Discord's own sidebar, and a category
    // sorts with its children rather than among them, hence its own position on both axes.
    if (channel.type === CATEGORY_TYPE) return [channel.position ?? 0, -1];

    return [parent?.position ?? -1, channel.position ?? 0];
  };

  return channels
    .sort((a, b) => {
      const [ac, ap] = rank(a);
      const [bc, bp] = rank(b);

      return ac === bc ? ap - bp : ac - bc;
    })
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parent_id ?? null,
      parentName: categories.get(channel.parent_id ?? '')?.name ?? null,
    }));
}

// An empty array here reads as "this server has no channels", and a save then writes that blank
// selection over a working config. Say which permission Discord refused instead.
function unreadable(what: 'channels' | 'roles', guildId: string, status: number): Error {
  if (status !== 403) return new Error(`Could not load the ${what} of ${guildId} (${status}).`);

  const missing = what === 'roles' ? 'Manage Roles' : 'View Channels';

  return new Error(
    `Proton cannot read the ${what} of ${guildId} — Discord refused with 403. ` +
      `Give it ${missing} in that server's settings.`,
  );
}
