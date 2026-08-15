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

interface WireGuildState {
  guildId: string;
  ownerId: string;
  everyoneRoleId: string;
  roles: Array<{ id: string; permissions: string; position: number }>;
  botRoleIds: string[];
  channels: Array<{ id: string; parentId: string | null; overwrites: WireOverwrite[] }>;
  updatedAt: number;
}

function encode(state: GuildState): string {
  const wire: WireGuildState = {
    guildId: state.guildId,
    ownerId: state.ownerId,
    everyoneRoleId: state.everyoneRoleId,
    roles: [...state.roles.values()].map((r) => ({
      id: r.id,
      permissions: r.permissions.toString(),
      position: r.position,
    })),
    botRoleIds: state.botRoleIds,
    channels: [...state.channels.values()].map((c) => ({
      id: c.id,
      parentId: c.parentId,
      overwrites: c.overwrites.map((o) => ({
        id: o.id,
        type: o.type,
        allow: o.allow.toString(),
        deny: o.deny.toString(),
      })),
    })),
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
    });
  }

  const channels = new Map<string, ChannelState>();
  for (const channel of wire.channels ?? []) {
    channels.set(channel.id, {
      id: channel.id,
      parentId: channel.parentId,
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
    }

    state.updatedAt = Date.now();
    await this.put(state);
  }

  async delete(guildId: string): Promise<void> {
    await this.#redis.del(this.#key(guildId));
  }
}
