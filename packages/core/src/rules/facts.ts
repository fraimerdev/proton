/** The entitlement ladder, lowest first (PLAN.md §6 `entitlements`). */
export const ENTITLEMENT_TIERS = ['free', 'plus', 'pro'] as const;

export type EntitlementTier = (typeof ENTITLEMENT_TIERS)[number];

/** Rank for comparison — `pro` satisfies a rule that asks for `plus`. */
export function entitlementRank(tier: EntitlementTier): number {
  return ENTITLEMENT_TIERS.indexOf(tier);
}

/**
 * What a rule is evaluated *about*, resolved once per event by the caller.
 *
 * The engine deliberately never reads `ProtonEvent.payload`: payloads are raw
 * Discord dispatches, and PLAN.md P1 keeps knowledge of those shapes inside the
 * gateway normaliser. Resolving facts at the edge also means every rule for the
 * guild sees one consistent snapshot rather than each predicate re-deriving its
 * own, so two conditions can never disagree about who the member is.
 *
 * Every field is optional because events differ: a `member.joined` has no
 * content, a `message.created` in a thread has no roles until they are fetched.
 * A condition that needs a fact it was not given fails closed and says which
 * fact was missing — never silently.
 *
 * There is no `guildId` here on purpose. The guild comes from the event, so
 * there is no second copy to drift out of step with it.
 */
export interface RuleFacts {
  /**
   * The member the event is *about* — the sender, the joiner, the actor in an
   * audit entry. Not to be confused with `ActionRequest.actorId`, which is who
   * ordered the resulting action (for a rule, the engine itself).
   */
  actorId?: string;
  channelId?: string;
  roleIds?: readonly string[];
  /** Message content. Absent unless the Message Content intent is granted. */
  content?: string;
  /** ms since epoch. Derived from `actorId`'s snowflake when not supplied. */
  accountCreatedAt?: number;
  /** The guild's entitlement tier; treated as `free` when unknown. */
  entitlement?: EntitlementTier;
}
