import {
  computeBasePermissions,
  type GuildRole,
  type Overwrite,
  parseOverwrites,
  parseRole,
  type RestProxyClient,
  type RestResponse,
  readGuildMember,
} from '@proton/core';
import type { ReviewActor } from '@proton/module-applications/authorize';

export const DISCORD_READ_TIMEOUT_MS = 5_000;
export const ROSTER_TTL_MS = 15_000;

const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;

export interface GuildRoster {
  guildId: string;
  name: string | null;
  iconHash: string | null;
  ownerId: string;
  everyoneRoleId: string;
  roles: ReadonlyMap<string, GuildRole>;
  botRoles: ReadonlyMap<string, string>;
}

export type MemberAccessRead =
  | {
      state: 'member';
      actor: ReviewActor;
      roleIds: string[];
      highestPosition: number;
      joinedAt: number | null;
      raw: Record<string, unknown>;
    }
  | { state: 'absent' }
  | { state: 'unavailable' };

export type ChannelRead =
  | { state: 'found'; guildId: string | null; overwrites: Overwrite[] }
  | { state: 'missing' }
  | { state: 'unavailable' };

export interface MemberAccess {
  read(guildId: string, userId: string): Promise<MemberAccessRead>;
  roles(guildId: string): Promise<GuildRoster | null>;
  channel(channelId: string): Promise<ChannelRead>;
  botUserId?(): Promise<string | null>;
}

export interface RestMemberAccessOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function discordCode(body: unknown): number | null {
  const code = record(body)?.code;
  return typeof code === 'number' ? code : null;
}

export function rosterOf(guildId: string, body: unknown): GuildRoster | null {
  const guild = record(body);
  const ownerId = text(guild?.owner_id);
  if (guild === null || ownerId === null || text(guild.id) !== guildId) return null;

  const roles = new Map<string, GuildRole>();
  const botRoles = new Map<string, string>();
  for (const raw of Array.isArray(guild.roles) ? guild.roles : []) {
    const role = parseRole(raw);
    if (role === null) continue;
    roles.set(role.id, role);

    const botId = text(record(record(raw)?.tags)?.bot_id);
    if (botId !== null) botRoles.set(role.id, botId);
  }

  return {
    guildId,
    name: text(guild.name),
    iconHash: text(guild.icon),
    ownerId,
    everyoneRoleId: guildId,
    roles,
    botRoles,
  };
}

export function highestPosition(roster: GuildRoster, roleIds: readonly string[]): number {
  let highest = 0;
  for (const roleId of roleIds) {
    const role = roster.roles.get(roleId);
    if (role !== undefined && role.position > highest) highest = role.position;
  }
  return highest;
}

export class RestMemberAccess implements MemberAccess {
  readonly #rest: RestProxyClient;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #rosters = new Map<string, { roster: GuildRoster; at: number }>();
  readonly #pending = new Map<string, Promise<GuildRoster | null>>();
  #self: string | null = null;

  constructor(rest: RestProxyClient, options: RestMemberAccessOptions = {}) {
    this.#rest = rest;
    this.#ttlMs = options.ttlMs ?? ROSTER_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? DISCORD_READ_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  async read(guildId: string, userId: string): Promise<MemberAccessRead> {
    const [member, roster] = await Promise.all([
      readGuildMember(this.#rest, guildId, userId, { timeoutMs: this.#timeoutMs }),
      this.roles(guildId),
    ]);

    if (member.state === 'absent') return { state: 'absent' };
    if (member.state !== 'member' || roster === null) return { state: 'unavailable' };

    const permissions = computeBasePermissions({
      guildOwnerId: roster.ownerId,
      everyoneRoleId: roster.everyoneRoleId,
      memberId: userId,
      memberRoleIds: member.roleIds,
      roles: roster.roles,
    });

    return {
      state: 'member',
      actor: {
        id: userId,
        roleIds: member.roleIds,
        permissions,
        owner: userId === roster.ownerId,
      },
      roleIds: member.roleIds,
      highestPosition: highestPosition(roster, member.roleIds),
      joinedAt: member.joinedAt,
      raw: member.raw,
    };
  }

  async roles(guildId: string): Promise<GuildRoster | null> {
    const cached = this.#rosters.get(guildId);
    if (cached !== undefined && this.#now() - cached.at < this.#ttlMs) return cached.roster;

    const inFlight = this.#pending.get(guildId);
    if (inFlight !== undefined) return inFlight;

    const reading = this.#readRoster(guildId).finally(() => this.#pending.delete(guildId));
    this.#pending.set(guildId, reading);
    return reading;
  }

  async botUserId(): Promise<string | null> {
    if (this.#self !== null) return this.#self;

    const response = await this.#get('/users/@me');
    if (response === null || response.status < 200 || response.status >= 300) return null;

    this.#self = text(record(response.body)?.id);
    return this.#self;
  }

  async channel(channelId: string): Promise<ChannelRead> {
    const response = await this.#get(`/channels/${channelId}`);
    if (response === null) return { state: 'unavailable' };

    if (response.status >= 200 && response.status < 300) {
      const channel = record(response.body);
      if (channel === null || text(channel.id) !== channelId) return { state: 'unavailable' };
      return {
        state: 'found',
        guildId: text(channel.guild_id),
        overwrites: parseOverwrites(channel.permission_overwrites),
      };
    }

    const code = discordCode(response.body);
    const missing =
      (response.status === 404 && code === UNKNOWN_CHANNEL) ||
      (response.status === 403 && code === MISSING_ACCESS);
    return missing ? { state: 'missing' } : { state: 'unavailable' };
  }

  async #readRoster(guildId: string): Promise<GuildRoster | null> {
    const response = await this.#get(`/guilds/${guildId}`);
    if (response === null || response.status < 200 || response.status >= 300) return null;

    const roster = rosterOf(guildId, response.body);
    if (roster !== null) this.#rosters.set(guildId, { roster, at: this.#now() });
    return roster;
  }

  async #get(path: string): Promise<RestResponse | null> {
    try {
      return await this.#rest.request({ method: 'GET', path, timeoutMs: this.#timeoutMs });
    } catch {
      return null;
    }
  }
}
