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
    throw new Error(
      `Discord answered ${response.status} when Proton asked which servers you administer.`,
    );
  }

  return (await response.json()) as DiscordUserGuild[];
}

export interface GuildRole {
  id: string;
  name: string;
  position: number;
  color: number;

  // Managed by an integration — a bot's own role, a subscription role, or the Booster role. No bot
  // can grant one, so a picker offering it is offering a 403 the admin only discovers in Discord.
  managed: boolean;
  premiumSubscriber: boolean;

  // False only where Proton's own highest role is known and sits at or below this one. Unknown
  // reads as assignable: refusing a role on a guess is worse than offering one that may fail.
  assignable: boolean;
}

interface RawRole {
  id: string;
  name: string;
  position: number;
  color?: number;
  managed?: boolean;
  tags?: Record<string, unknown> | null;
}

/**
 * Verified against docs.discord.com/developers/topics/permissions: `managed` says a role belongs to
 * an integration, and `tags.premium_subscriber` names the Booster role. `botUserId` is Proton's own
 * user id; given one, the ceiling below turns "above Proton's own role" into something the picker
 * can say before the save rather than after it.
 */
export async function fetchGuildRoles(
  restProxyUrl: string,
  guildId: string,
  botUserId?: string,
): Promise<GuildRole[]> {
  const base = restProxyUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/api/guilds/${guildId}/roles`);

  if (!response.ok) throw unreadable('roles', response.status);

  const roles = (await response.json()) as RawRole[];

  const ceiling =
    botUserId === undefined ? null : await protonRoleCeiling(base, guildId, botUserId, roles);

  return roles
    .filter((role) => role.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.color ?? 0,
      managed: role.managed === true,
      // `premium_subscriber` is documented as type null: the key is present on the Booster role and
      // absent on every other, so its presence is the flag and its value is never true.
      premiumSubscriber: role.tags != null && 'premium_subscriber' in role.tags,
      assignable: ceiling === null || role.position < ceiling,
    }));
}

/**
 * The position of Proton's own highest role. A bot may only grant roles strictly below it, so this
 * is the ceiling the picker blocks above. null means unreadable — a guild Proton has just been
 * added to, or a member read Discord refused — and the caller must then claim nothing.
 */
async function protonRoleCeiling(
  base: string,
  guildId: string,
  botUserId: string,
  roles: readonly RawRole[],
): Promise<number | null> {
  const response = await fetch(`${base}/api/guilds/${guildId}/members/${botUserId}`).catch(
    () => null,
  );

  if (!response?.ok) return null;

  const member = (await response.json().catch(() => null)) as { roles?: string[] } | null;
  const held = new Set(member?.roles ?? []);

  const positions = roles.filter((role) => held.has(role.id)).map((role) => role.position);

  return positions.length === 0 ? null : Math.max(...positions);
}

export interface GuildMember {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bot: boolean;
}

const CDN = 'https://cdn.discordapp.com';

// Verified against docs.discord.com/developers/reference: a per-guild avatar lives under the guild,
// a global one under the user, and a member with neither gets the default indexed by their own id.
function avatarUrl(guildId: string, user: RawUser, memberAvatar: string | null): string | null {
  if (memberAvatar) return `${CDN}/guilds/${guildId}/users/${user.id}/avatars/${memberAvatar}.png`;
  if (user.avatar) return `${CDN}/avatars/${user.id}/${user.avatar}.png`;

  if (user.discriminator && user.discriminator !== '0') {
    return `${CDN}/embed/avatars/${Number(user.discriminator) % 5}.png`;
  }

  return `${CDN}/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;
}

interface RawUser {
  id: string;
  username?: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

interface RawMember {
  user?: RawUser;
  nick?: string | null;
  avatar?: string | null;
  roles?: string[];
}

// Discord has no batch endpoint for a known set of ids, so this is one request each, six at a time
// through the shared bucket. The cap is what a page of the case log or the leaderboard can show.
const MEMBER_BATCH_MAX = 100;
const MEMBER_CONCURRENCY = 6;

/**
 * The members behind a page's snowflakes. An id that does not resolve is simply absent from the
 * answer — a member who has left the server is the normal case, and inventing a name for them
 * would be worse than printing the id. Only a wholesale refusal is raised, so a page that can
 * resolve nobody says why instead of quietly reading as a column of numbers.
 */
export async function fetchGuildMembers(
  restProxyUrl: string,
  guildId: string,
  userIds: readonly string[],
): Promise<GuildMember[]> {
  const base = restProxyUrl.replace(/\/$/, '');
  const wanted = [...new Set(userIds)].slice(0, MEMBER_BATCH_MAX);

  if (wanted.length === 0) return [];

  const found: GuildMember[] = [];
  let refusal = 0;

  for (let at = 0; at < wanted.length; at += MEMBER_CONCURRENCY) {
    const slice = wanted.slice(at, at + MEMBER_CONCURRENCY);

    const answers = await Promise.all(
      slice.map(async (id) => {
        const response = await fetch(`${base}/api/guilds/${guildId}/members/${id}`).catch(
          () => null,
        );

        if (!response) return { status: 0 };
        if (!response.ok) return { status: response.status };

        return { status: 200, member: (await response.json().catch(() => null)) as RawMember };
      }),
    );

    for (const answer of answers) {
      if (answer.status !== 404 && answer.status !== 200) refusal = answer.status;

      const user = answer.member?.user;
      if (!user) continue;

      found.push({
        id: user.id,
        displayName: answer.member?.nick || user.global_name || user.username || user.id,
        username: user.username ?? user.id,
        avatarUrl: avatarUrl(guildId, user, answer.member?.avatar ?? null),
        bot: user.bot === true,
      });
    }
  }

  if (found.length === 0 && refusal !== 0) throw unreadable('members', refusal);

  return found;
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

  if (!response.ok) throw unreadable('channels', response.status);

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

export interface GuildEmoji {
  id: string;
  name: string;
  animated: boolean;
}

/**
 * The server's own custom emoji, for the picker. Verified against
 * docs.discord.com/developers/resources/emoji: `GET /guilds/{id}/emojis`, and no permission gates
 * the read — `MANAGE_GUILD_EXPRESSIONS` only adds the `user` field, which this drops anyway.
 */
export async function fetchGuildEmojis(
  restProxyUrl: string,
  guildId: string,
): Promise<GuildEmoji[]> {
  const response = await fetch(`${restProxyUrl.replace(/\/$/, '')}/api/guilds/${guildId}/emojis`);

  if (!response.ok) throw unreadable('emoji', response.status);

  const emojis = (await response.json()) as Array<{
    id?: string | null;
    name?: string | null;
    animated?: boolean;
    available?: boolean;
  }>;

  return (
    emojis
      // `available: false` is an emoji the server has lost the boost level to use. Discord hides
      // those in its own picker, and posting one fails, so offering it is offering a broken choice.
      .filter((emoji) => emoji.available !== false && emoji.id && emoji.name)
      .map((emoji) => ({
        id: emoji.id as string,
        name: emoji.name as string,
        animated: emoji.animated === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}

// An empty array here reads as "this server has no channels", and a save then writes that blank
// selection over a working config. Say which permission Discord refused instead.
function unreadable(what: 'channels' | 'roles' | 'emoji' | 'members', status: number): Error {
  // "this server", not the snowflake: the page already names the server everywhere else, and the
  // destination is the same literal path every other failure in the product prints.
  if (status !== 403)
    return new Error(
      `Proton could not read this server's ${what} — Discord answered ${status}. Reload the page; ` +
        `if it keeps happening, Discord is the part that is refusing.`,
    );

  // Listing emoji and reading one member need no permission at all, so a 403 on either is not a
  // missing-permission story — it is Discord refusing the bot itself, and naming a permission to
  // grant would send the admin to a settings page that cannot fix it.
  if (what === 'emoji' || what === 'members')
    return new Error(
      `Proton cannot read this server's ${what} — Discord refused with 403. Reading ${what} needs ` +
        `no permission, so this is Discord refusing Proton itself rather than a setting to change.`,
    );

  const missing = what === 'roles' ? 'Manage Roles' : 'View Channels';

  return new Error(
    `Proton cannot read this server's ${what} — Discord refused with 403, because Proton's role ` +
      `does not have ${missing}. Give it that permission in Server Settings → Roles → Proton.`,
  );
}
