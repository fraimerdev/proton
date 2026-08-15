export const ENTITLEMENT_TIERS = ['free', 'plus', 'pro'] as const;

export type EntitlementTier = (typeof ENTITLEMENT_TIERS)[number];

export function entitlementRank(tier: EntitlementTier): number {
  return ENTITLEMENT_TIERS.indexOf(tier);
}

export interface RuleFacts {
  actorId?: string;
  channelId?: string;
  roleIds?: readonly string[];

  content?: string;

  accountCreatedAt?: number;

  entitlement?: EntitlementTier;
}
