import type { Redis } from 'ioredis';
import type { GuildRole, Overwrite } from '../permissions/compute.ts';
import type { ChannelState, GuildState, GuildStatePatch, GuildStateStore } from './types.ts';

export const GUILD_STATE_PREFIX = 'proton:guild-state';

interface WireOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

type WireRole = Omit<GuildRole, 'permissions'> & { permissions: string };

type WireChannel = Omit<ChannelState, 'overwrites'> & { overwrites: WireOverwrite[] };

// Derived from GuildState so a new field breaks this build instead of vanishing into Redis.
type WireGuildState = Omit<GuildState, 'roles' | 'channels'> & {
  roles: WireRole[];
  channels: WireChannel[];
};

function encode(state: GuildState): string {
  const wire: WireGuildState = {
    guildId: state.guildId,
    ownerId: state.ownerId,
    everyoneRoleId: state.everyoneRoleId,
    roles: [...state.roles.values()].map((r) => ({
      id: r.id,
      permissions: r.permissions.toString(),
      position: r.position,
      ...(r.managed === undefined ? {} : { managed: r.managed }),
    })),
    botRoleIds: state.botRoleIds,
    channels: [...state.channels.values()].map((c) => ({
      id: c.id,
      parentId: c.parentId,
      ...(c.type === undefined ? {} : { type: c.type }),
      overwrites: c.overwrites.map((o) => ({
        id: o.id,
        type: o.type,
        allow: o.allow.toString(),
        deny: o.deny.toString(),
      })),
    })),
    ...(state.name === undefined ? {} : { name: state.name }),
    ...(state.memberCount === undefined ? {} : { memberCount: state.memberCount }),
    updatedAt: state.updatedAt,
  };

  return JSON.stringify(wire);
}

function decode(raw: string): GuildState | null {
  let wire: WireGuildState;
  try {
    wire = JSON.parse(raw) as WireGuildState;
  } catch {
    return null;
  }

  const roles = new Map<string, GuildRole>();
  for (const role of wire.roles ?? []) {
    roles.set(role.id, {
      id: role.id,
      permissions: BigInt(role.permissions),
      position: role.position,
      ...(role.managed === undefined ? {} : { managed: role.managed }),
    });
  }

  const channels = new Map<string, ChannelState>();
  for (const channel of wire.channels ?? []) {
    channels.set(channel.id, {
      id: channel.id,
      parentId: channel.parentId,
      ...(channel.type === undefined ? {} : { type: channel.type }),
      overwrites: (channel.overwrites ?? []).map(
        (o): Overwrite => ({
          id: o.id,
          type: o.type,
          allow: BigInt(o.allow),
          deny: BigInt(o.deny),
        }),
      ),
    });
  }

  return {
    guildId: wire.guildId,
    ownerId: wire.ownerId,
    everyoneRoleId: wire.everyoneRoleId,
    roles,
    botRoleIds: wire.botRoleIds ?? [],
    channels,
    ...(wire.name === undefined ? {} : { name: wire.name }),
    ...(wire.memberCount === undefined ? {} : { memberCount: wire.memberCount }),
    updatedAt: wire.updatedAt,
  };
}

export class RedisGuildStateStore implements GuildStateStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlSeconds: number | null;

  constructor(redis: Redis, options: { prefix?: string; ttlSeconds?: number | null } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? GUILD_STATE_PREFIX;
    this.#ttlSeconds = options.ttlSeconds === undefined ? 7 * 24 * 60 * 60 : options.ttlSeconds;
  }

  #key(guildId: string): string {
    return `${this.#prefix}:${guildId}`;
  }

  async get(guildId: string): Promise<GuildState | null> {
    const raw = await this.#redis.get(this.#key(guildId));
    return raw ? decode(raw) : null;
  }

  async put(state: GuildState): Promise<void> {
    const key = this.#key(state.guildId);
    const payload = encode(state);

    if (this.#ttlSeconds === null) {
      await this.#redis.set(key, payload);
      return;
    }
    await this.#redis.set(key, payload, 'EX', this.#ttlSeconds);
  }

  async patch(guildId: string, patch: GuildStatePatch): Promise<void> {
    const state = await this.get(guildId);
    if (!state) return;

    switch (patch.kind) {
      case 'role.upsert':
        state.roles.set(patch.role.id, patch.role);
        break;
      case 'role.delete':
        state.roles.delete(patch.roleId);
        break;
      case 'channel.upsert':
        state.channels.set(patch.channel.id, patch.channel);
        break;
      case 'channel.delete':
        state.channels.delete(patch.channelId);
        break;
      case 'bot.roles':
        state.botRoleIds = patch.roleIds;
        break;
      case 'member.count':
        // Floored at zero: a leave seen without its matching join would otherwise render a
        // welcome message counting a negative number of members.
        if (state.memberCount !== undefined) {
          state.memberCount = Math.max(0, state.memberCount + patch.delta);
        }
        break;
    }

    state.updatedAt = Date.now();
    await this.put(state);
  }

  async delete(guildId: string): Promise<void> {
    await this.#redis.del(this.#key(guildId));
  }
}
