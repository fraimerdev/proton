import { ENTITLEMENT_TIERS, type EntitlementTier, entitlementRank } from '../rules/facts.ts';

export const LIMIT_KEYS = [
  'tags',
  'activeGiveaways',
  'remindersPerUser',
  'ticketPanels',
  'openTicketsPerUser',
  'counters',
  'tempVcHubs',
  'savedTemplates',
  'activePolls',
  'honeypotChannels',
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_LABELS: Record<LimitKey, string> = {
  tags: 'tags',
  activeGiveaways: 'running giveaways',
  remindersPerUser: 'reminders per member',
  ticketPanels: 'ticket panels',
  openTicketsPerUser: 'open tickets per member',
  counters: 'counter channels',
  tempVcHubs: 'temporary-voice hubs',
  savedTemplates: 'saved templates',
  activePolls: 'running polls',
  honeypotChannels: 'honeypot channels',
};

export const TIER_LIMITS: Record<EntitlementTier, Record<LimitKey, number>> = {
  free: {
    tags: 25,
    activeGiveaways: 3,
    remindersPerUser: 10,
    ticketPanels: 2,
    openTicketsPerUser: 3,
    counters: 5,
    tempVcHubs: 2,
    savedTemplates: 10,
    activePolls: 3,
    honeypotChannels: 3,
  },
  plus: {
    tags: 125,
    activeGiveaways: 15,
    remindersPerUser: 50,
    ticketPanels: 10,
    openTicketsPerUser: 15,
    counters: 25,
    tempVcHubs: 10,
    savedTemplates: 50,
    activePolls: 15,
    honeypotChannels: 10,
  },
  pro: {
    tags: 500,
    activeGiveaways: 60,
    remindersPerUser: 200,
    ticketPanels: 40,
    openTicketsPerUser: 60,
    counters: 100,
    tempVcHubs: 40,
    savedTemplates: 200,
    activePolls: 60,
    honeypotChannels: 25,
  },
};

// Two of the ten are counted per member, not per guild. Without this the refusal reads "this
// server is already at 10" at a member who is the only one who has any.
export const PER_MEMBER_KEYS: ReadonlySet<LimitKey> = new Set<LimitKey>([
  'remindersPerUser',
  'openTicketsPerUser',
]);

function subject(key: LimitKey): string {
  return PER_MEMBER_KEYS.has(key) ? 'you are already at' : 'this server is already at';
}

export type LimitCheck =
  | { ok: true }
  | { ok: false; limit: number; tier: EntitlementTier; humanReason: string };

export function limitFor(tier: EntitlementTier, key: LimitKey): number {
  return TIER_LIMITS[tier][key];
}

function nextTier(tier: EntitlementTier): EntitlementTier | undefined {
  return ENTITLEMENT_TIERS[entitlementRank(tier) + 1];
}

function advice(tier: EntitlementTier, key: LimitKey): string {
  const next = nextTier(tier);

  return next
    ? `Remove one first, or move to ${next} for ${limitFor(next, key)}.`
    : `Remove one first — ${tier} is the highest tier there is.`;
}

export function checkLimit(tier: EntitlementTier, key: LimitKey, current: number): LimitCheck {
  const limit = limitFor(tier, key);
  if (current < limit) return { ok: true };

  return {
    ok: false,
    limit,
    tier,
    humanReason:
      `the ${tier} tier allows ${limit} ${LIMIT_LABELS[key]} and ${subject(key)} ` +
      `${current}. ${advice(tier, key)}`,
  };
}

// Not checkLimit(tier, key, length - 1): a saved list is judged whole rather than one addition at
// a time, and reusing the other wording would report a count the admin never typed.
export function checkListLimit(tier: EntitlementTier, key: LimitKey, length: number): LimitCheck {
  const limit = limitFor(tier, key);
  if (length <= limit) return { ok: true };

  return {
    ok: false,
    limit,
    tier,
    humanReason:
      `the ${tier} tier allows ${limit} ${LIMIT_LABELS[key]} and this would save ${length}. ` +
      advice(tier, key),
  };
}
