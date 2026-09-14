import type { GuildRole, Overwrite } from '../permissions/compute.ts';
import type { ChannelState, GuildProfile, GuildState } from './types.ts';

const IMAGE_HASH = /^[A-Za-z0-9_]{1,64}$/;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function own(payload: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : undefined;
}

function imageHash(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && IMAGE_HASH.test(value) ? value : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseGuildProfile(payload: Record<string, unknown>): GuildProfile {
  const name = str(own(payload, 'name'));
  const iconHash = imageHash(own(payload, 'icon'));
  const bannerHash = imageHash(own(payload, 'banner'));
  const description = nullableText(own(payload, 'description'));
  const rawBoostCount = own(payload, 'premium_subscription_count');
  const boostCount = rawBoostCount === null ? null : count(rawBoostCount);
  const boostTier = count(own(payload, 'premium_tier'));

  return {
    ...(name ? { name } : {}),
    ...(iconHash === undefined ? {} : { iconHash }),
    ...(bannerHash === undefined ? {} : { bannerHash }),
    ...(description === undefined ? {} : { description }),
    ...(boostCount === undefined ? {} : { boostCount }),
    ...(boostTier === undefined ? {} : { boostTier }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function bits(value: unknown): bigint {
  if (typeof value === 'string' && value !== '') {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function parseRole(raw: unknown): GuildRole | null {
  const role = record(raw);
  const id = str(role?.id);
  if (!role || !id) return null;

  return {
    id,
    permissions: bits(role.permissions),
    position: typeof role.position === 'number' ? role.position : 0,

    ...(typeof role.managed === 'boolean' ? { managed: role.managed } : {}),
  };
}

export function parseOverwrites(raw: unknown): Overwrite[] {
  const result: Overwrite[] = [];

  for (const entry of array(raw)) {
    const overwrite = record(entry);
    const id = str(overwrite?.id);
    if (!overwrite || !id) continue;

    result.push({
      id,
      type: overwrite.type === 1 ? 1 : 0,
      allow: bits(overwrite.allow),
      deny: bits(overwrite.deny),
    });
  }

  return result;
}

export function parseChannel(raw: unknown): ChannelState | null {
  const channel = record(raw);
  const id = str(channel?.id);
  if (!channel || !id) return null;

  return {
    id,
    parentId: str(channel.parent_id),
    ...(typeof channel.type === 'number' ? { type: channel.type } : {}),
    ...(str(channel.name) === null ? {} : { name: str(channel.name) as string }),
    overwrites: parseOverwrites(channel.permission_overwrites),
  };
}

export function buildGuildState(
  payload: Record<string, unknown>,
  botUserId: string,
  now: number = Date.now(),
): GuildState | null {
  const guildId = str(payload.id);
  const ownerId = str(payload.owner_id);
  if (!guildId || !ownerId) return null;

  const roles = new Map<string, GuildRole>();
  for (const raw of array(payload.roles)) {
    const role = parseRole(raw);
    if (role) roles.set(role.id, role);
  }

  const channels = new Map<string, ChannelState>();
  // Threads share this map: lookups do channels.get(id), so a split map hides parent overwrites.
  for (const raw of [...array(payload.channels), ...array(payload.threads)]) {
    const channel = parseChannel(raw);
    if (channel) channels.set(channel.id, channel);
  }

  let botRoleIds: string[] = [];
  for (const raw of array(payload.members)) {
    const member = record(raw);
    if (str(record(member?.user)?.id) !== botUserId) continue;
    botRoleIds = array(member?.roles).filter((r): r is string => typeof r === 'string');
    break;
  }

  const memberCount = payload.member_count;

  return {
    guildId,
    ownerId,

    everyoneRoleId: guildId,
    roles,
    botRoleIds,
    channels,
    ...parseGuildProfile(payload),
    ...(typeof memberCount === 'number' ? { memberCount } : {}),
    profileAt: now,
    updatedAt: now,
  };
}
