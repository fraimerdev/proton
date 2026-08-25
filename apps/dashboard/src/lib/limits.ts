import type { EntitlementTier, LimitKey } from '@proton/core';
import { LIMIT_LABELS, limitFor } from '@proton/core';

const TIER_LABELS: Record<EntitlementTier, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
};

export function tierLabel(tier: EntitlementTier): string {
  return TIER_LABELS[tier];
}

// The panels used to draw their Add button against the pro ceiling, which is what the Zod schema
// accepts — so a Free server could build twenty counters before the save named the real limit of
// five. The ceiling shown here is the one this server actually has.
export function listCeiling(tier: EntitlementTier, key: LimitKey): number {
  return limitFor(tier, key);
}

export function ceilingNote(tier: EntitlementTier, key: LimitKey): string {
  const limit = limitFor(tier, key);
  const label = LIMIT_LABELS[key];

  return tier === 'pro'
    ? `Limit of ${limit} ${label} reached`
    : `${tierLabel(tier)} allows ${limit} ${label}`;
}
