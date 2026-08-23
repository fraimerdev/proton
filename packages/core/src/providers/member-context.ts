import { snowflakeCreatedAt } from '../ids.ts';
import type { EntitlementTier, RuleFacts } from '../rules/facts.ts';
import type { MemberContext } from './types.ts';

export interface MemberContextLoader {
  load(guildId: string, userIds: readonly string[]): Promise<Map<string, MemberContext>>;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.length === 0) return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function createdAtOf(userId: string): Date | null {
  const ms = snowflakeCreatedAt(userId);
  return ms === null ? null : new Date(ms);
}

export function memberContextFromRuleFacts(
  guildId: string,
  facts: RuleFacts,
  now: Date,
): MemberContext | null {
  const userId = facts.actorId;
  if (userId === undefined) return null;

  const createdAt =
    facts.accountCreatedAt !== undefined ? new Date(facts.accountCreatedAt) : createdAtOf(userId);
  if (createdAt === null) return null;

  return {
    guildId,
    userId,
    // Rule facts carry no join date, boost date or timeout state, so a provider that needs one
    // must report indeterminate rather than read these absences as zero.
    member: {
      joinedAt: null,
      roleIds: facts.roleIds ? [...facts.roleIds] : null,
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt, hasAvatar: null, bot: false },
    tier: facts.entitlement ?? 'free',
    partial: true,
    now,
  };
}

export function memberContextFromGuildMember(
  guildId: string,
  raw: unknown,
  now: Date,
  tier: EntitlementTier = 'free',
): MemberContext | null {
  const member = asRecord(raw);
  const user = asRecord(member?.user);
  if (member === null || user === null) return null;

  const userId = typeof user.id === 'string' ? user.id : null;
  if (userId === null) return null;

  const createdAt = createdAtOf(userId);
  if (createdAt === null) return null;

  const roles = member.roles;

  return {
    guildId,
    userId,
    member: {
      joinedAt: toDate(member.joined_at),
      roleIds: Array.isArray(roles)
        ? roles.filter((id): id is string => typeof id === 'string')
        : null,
      premiumSince: toDate(member.premium_since),
      communicationDisabledUntil: toDate(member.communication_disabled_until),
    },
    user: {
      createdAt,
      hasAvatar: typeof user.avatar === 'string' && user.avatar.length > 0,
      bot: user.bot === true,
    },
    tier,
    now,
  };
}

export function absentMemberContext(
  guildId: string,
  userId: string,
  now: Date,
  tier: EntitlementTier = 'free',
): MemberContext | null {
  const createdAt = createdAtOf(userId);
  if (createdAt === null) return null;

  return {
    guildId,
    userId,
    member: null,
    user: { createdAt, hasAvatar: null, bot: false },
    tier,
    now,
  };
}

export class StaticMemberContextLoader implements MemberContextLoader {
  readonly #contexts: Map<string, MemberContext>;

  constructor(contexts: Iterable<MemberContext>) {
    this.#contexts = new Map([...contexts].map((ctx) => [ctx.userId, ctx]));
  }

  async load(guildId: string, userIds: readonly string[]): Promise<Map<string, MemberContext>> {
    const loaded = new Map<string, MemberContext>();

    for (const userId of userIds) {
      const known = this.#contexts.get(userId);
      const ctx = known ?? absentMemberContext(guildId, userId, new Date());
      if (ctx) loaded.set(userId, ctx);
    }

    return loaded;
  }
}
