import { type ProtonEvent, snowflakeCreatedAt } from '@proton/core';

/** What the heuristics need to know about one join. */
export interface JoinFacts {
  userId: string;
  /**
   * Bots are skipped entirely. A bot is added by someone holding MANAGE_GUILD,
   * which makes a hostile one anti-nuke's problem rather than anti-raid's, and a
   * freshly created utility bot trips both the age and the avatar heuristic.
   */
  isBot: boolean;
  /** Null when the dispatch did not say — an absent field is not evidence. */
  avatarless: boolean | null;
  /** ms since epoch, from the snowflake. Null when the id is not one. */
  accountCreatedAt: number | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Read a `member.joined` event.
 *
 * The one place in this module that knows Discord's GUILD_MEMBER_ADD shape.
 * PLAN.md P1 keeps dispatch shapes inside the gateway normaliser and `RuleFacts`
 * keeps them out of the rule engine, but a listener is handed the raw payload —
 * so the knowledge is confined to this function rather than spread across the
 * scorer and the handler, the way the logging module confines its own.
 *
 * No REST call and no member cache: everything here is either in the dispatch or
 * inside the snowflake. That matters more than it looks. Request Guild Members
 * is capped at one call per guild per 30 seconds (§10.4), so a heuristic needing
 * a lookup would be useless during the first minute of a raid — the only minute
 * that counts.
 */
export function readJoin(event: ProtonEvent): JoinFacts | null {
  const d = record(event.payload);
  const user = record(d?.user);
  if (!d || !user) return null;

  const userId = str(user.id);
  if (!userId) return null;

  // Discord always sends `avatar` on a user object, null when they never set
  // one; the member-level `avatar` is a per-guild override a returning member can
  // have, so both must be absent before the account counts as avatarless. A
  // payload that omits the field altogether is unknown, not avatarless — scoring
  // an absence as a signal is how a heuristic quietly becomes a coin flip.
  const avatarless = 'avatar' in user ? str(user.avatar) === null && str(d.avatar) === null : null;

  return {
    userId,
    isBot: user.bot === true,
    avatarless,
    accountCreatedAt: snowflakeCreatedAt(userId),
  };
}
