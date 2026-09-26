import {
  badgeImageSchema,
  type CardBadge,
  RANK_CARD_BADGES_MAX,
  TIER_COLOURS,
  toHexColour,
} from '@proton/cards';
import { type RestProxyClient, snowflakeSchema } from '@proton/core';
import type { DbHandle } from '@proton/db';
import {
  MODULE_ID as ACHIEVEMENTS_MODULE_ID,
  type AchievementStore,
  achievementsConfigSchema,
  badgeCardFor,
  type ChannelKind,
  type LevelHolder,
  type ListedMember,
  type MemberLookup,
  type UnlockRow,
} from '@proton/module-achievements';
import { badgeSchema } from '@proton/module-achievements/config';
import { levelForXp, xpForLevel } from '@proton/module-leveling/curve';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import { epochOf } from './member-lookup.ts';
import { isNotMember } from './member-roles.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from './runtime.ts';

const MEMBER_PAGE_MAX = 1000;

const DEFAULT_BADGE = badgeSchema.parse({});

const NO_BADGES: { badges: CardBadge[]; count: number } = { badges: [], count: 0 };

const discordErrorSchema = z.looseObject({ code: z.number().int().optional() });

const memberSchema = z.object({
  user: z.object({ bot: z.boolean().optional() }).optional(),
  roles: z.array(z.string()).default([]),
  joined_at: z.string().nullish(),
  premium_since: z.string().nullish(),
});

const memberPageSchema = z.array(
  z.object({
    user: z.object({ id: snowflakeSchema, bot: z.boolean().optional() }),
    joined_at: z.string().nullish(),
  }),
);

function answeredBy(status: number): string {
  return `${status < 500 ? 'Discord' : 'the REST proxy'} answered ${status}`;
}

function discordCode(body: unknown): number | undefined {
  const parsed = discordErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.code : undefined;
}

function bySnowflake(a: { userId: string }, b: { userId: string }): number {
  const left = BigInt(a.userId);
  const right = BigInt(b.userId);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function effectivelyEnabled(snapshot: ModuleConfigSnapshot): boolean {
  const config = snapshot.config as { enabled?: unknown } | null | undefined;
  return snapshot.enabled && config?.enabled !== false;
}

export function createMemberFacts(
  rest: RestProxyClient,
): (guildId: string, userId: string) => Promise<MemberLookup | null> {
  return async (guildId, userId) => {
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${userId}`,
    });

    if (isNotMember(response.status, response.body)) return null;
    if (response.status >= 400) {
      throw new Error(
        `reading their membership of ${guildId} failed: ${answeredBy(response.status)}`,
      );
    }

    const member = memberSchema.safeParse(response.body);
    if (!member.success) {
      throw new Error(`Discord sent their membership of ${guildId} in a shape Proton cannot read`);
    }

    return {
      roleIds: member.data.roles,
      bot: member.data.user?.bot === true,
      joinedAt: epochOf(member.data.joined_at),
      premiumSince: epochOf(member.data.premium_since),
    };
  };
}

function listFailure(guildId: string, status: number, body: unknown): string {
  const code = discordCode(body);

  if (code === RESTJSONErrorCodes.MissingAccess) {
    return (
      `Discord refused to list the members of ${guildId} (${status}, code ${code}). Either the ` +
      'Server Members privileged intent is off for this application (turn it on under Bot → ' +
      'Privileged Gateway Intents in the Discord Developer Portal), or Proton is no longer in ' +
      'this server.'
    );
  }

  return (
    `listing the members of ${guildId} failed: ${answeredBy(status)}` +
    (code === undefined ? '' : ` (code ${code})`)
  );
}

export function createMemberPages(
  rest: RestProxyClient,
): (guildId: string, afterUserId: string | null, limit: number) => Promise<ListedMember[]> {
  return async (guildId, afterUserId, limit) => {
    const size = Math.min(Math.max(Math.trunc(limit), 1), MEMBER_PAGE_MAX);
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members?limit=${size}&after=${afterUserId ?? '0'}`,
    });

    if (response.status >= 400) {
      throw new Error(listFailure(guildId, response.status, response.body));
    }

    // A dropped entry would shorten the page into looking like the last one.
    const page = memberPageSchema.safeParse(response.body);
    if (!page.success) {
      throw new Error(`Discord sent a page of ${guildId}'s members that Proton cannot read`);
    }

    return page.data
      .map((member) => ({
        userId: member.user.id,
        bot: member.user.bot === true,
        joinedAt: epochOf(member.joined_at),
      }))
      .sort(bySnowflake);
  };
}

export function createLevelHolders(
  handle: DbHandle,
): (
  guildId: string,
  minLevel: number,
  afterUserId: string | null,
  limit: number,
) => Promise<LevelHolder[]> {
  return async (guildId, minLevel, afterUserId, limit) => {
    const rows = await handle.client<{ user_id: string; xp: number }[]>`
      select user_id, xp
        from members
       where guild_id = ${guildId}
         and xp >= ${xpForLevel(minLevel)}
         and user_id > ${afterUserId ?? ''}
       order by user_id
       limit ${Math.max(0, Math.trunc(limit))}`;

    return rows.map((row) => ({ userId: row.user_id, level: levelForXp(row.xp) }));
  };
}

export interface ChannelKindSources {
  tickets: { byChannel(guildId: string, channelId: string): Promise<object | null> };
  temporary: {
    byChannel(guildId: string, channelId: string): Promise<{ status: string } | null>;
  };
}

export function createChannelKind(
  sources: ChannelKindSources,
): (guildId: string, channelId: string) => Promise<ChannelKind | null> {
  return async (guildId, channelId) => {
    const [ticket, temporary] = await Promise.all([
      sources.tickets.byChannel(guildId, channelId),
      sources.temporary.byChannel(guildId, channelId),
    ]);

    if (ticket !== null) return 'ticket';
    return temporary?.status === 'live' ? 'temporary' : null;
  };
}

export interface AchievementBadgeSources {
  store: Pick<AchievementStore, 'topBadges' | 'earnedCount' | 'badge'>;
  config: ConfigProvider;
}

export function createAchievementBadges(
  sources: AchievementBadgeSources,
): (guildId: string, userId: string) => Promise<{ badges: CardBadge[]; count: number }> {
  const { store, config } = sources;

  return async (guildId, userId) => {
    const snapshot = await config.get(guildId, ACHIEVEMENTS_MODULE_ID);
    if (!snapshot.enabled) return NO_BADGES;

    const parsed = achievementsConfigSchema.safeParse(snapshot.config);
    if (!parsed.success || !parsed.data.enabled) return NO_BADGES;

    const [rows, count] = await Promise.all([
      store.topBadges(guildId, userId, RANK_CARD_BADGES_MAX),
      store.earnedCount(guildId, userId, []),
    ]);
    const configured = new Map(parsed.data.achievements.map((entry) => [entry.id, entry]));

    const badgeOf = async (row: UnlockRow): Promise<CardBadge> => {
      const achievement = configured.get(row.achievementId);
      if (!achievement) {
        return {
          shape: DEFAULT_BADGE.shape,
          colour: toHexColour(TIER_COLOURS[row.tierId]),
          icon: DEFAULT_BADGE.icon,
        };
      }

      const { assetId } = achievement.badge;
      const asset = assetId === undefined ? null : await store.badge(guildId, assetId);
      const uri = asset ? `data:${asset.contentType};base64,${asset.base64}` : null;
      // A stored image the card schema refuses would fail the whole /rank, so it falls to the icon.
      const image = uri !== null && badgeImageSchema.safeParse(uri).success ? uri : null;
      const { kind: _kind, ...badge } = badgeCardFor(achievement, row.tierId, image);
      return badge;
    };

    return { badges: await Promise.all(rows.map(badgeOf)), count };
  };
}
