import { ENTITLEMENT_TIERS, type EntitlementTier, entitlementRank } from '../rules/facts.ts';

export const LIMIT_KEYS = [
  'tags',
  'activeGiveaways',
  'remindersPerUser',
  'ticketPanels',
  'ticketTypes',
  'openTicketsPerUser',
  'counters',
  'tempVcHubs',
  'savedTemplates',
  'activePolls',
  'honeypotChannels',
  'appealPanels',
  'achievements',
  'applicationForms',
  'applicationPanels',
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_LABELS: Record<LimitKey, string> = {
  tags: 'tags',
  activeGiveaways: 'running giveaways',
  remindersPerUser: 'reminders per member',
  ticketPanels: 'ticket panels',
  ticketTypes: 'ticket types',
  openTicketsPerUser: 'open tickets per member',
  counters: 'counter channels',
  tempVcHubs: 'creator channels',
  savedTemplates: 'saved templates',
  activePolls: 'running polls',
  honeypotChannels: 'honeypot channels',
  appealPanels: 'appeal forms',
  achievements: 'achievements',
  applicationForms: 'application forms',
  applicationPanels: 'application panels',
};

export const TIER_LIMITS: Record<EntitlementTier, Record<LimitKey, number>> = {
  free: {
    tags: 25,
    activeGiveaways: 3,
    remindersPerUser: 10,
    ticketPanels: 3,
    ticketTypes: 5,
    openTicketsPerUser: 3,
    counters: 5,
    tempVcHubs: 2,
    savedTemplates: 15,
    activePolls: 3,
    honeypotChannels: 1,
    appealPanels: 1,
    achievements: 10,
    applicationForms: 3,
    applicationPanels: 2,
  },
  plus: {
    tags: 150,
    activeGiveaways: 15,
    remindersPerUser: 40,
    ticketPanels: 10,
    ticketTypes: 25,
    openTicketsPerUser: 5,
    counters: 20,
    tempVcHubs: 8,
    savedTemplates: 100,
    activePolls: 15,
    honeypotChannels: 3,
    appealPanels: 3,
    achievements: 50,
    applicationForms: 12,
    applicationPanels: 6,
  },
  pro: {
    tags: 500,
    activeGiveaways: 40,
    remindersPerUser: 100,
    ticketPanels: 25,
    ticketTypes: 60,
    openTicketsPerUser: 10,
    counters: 50,
    tempVcHubs: 20,
    savedTemplates: 250,
    activePolls: 40,
    honeypotChannels: 8,
    appealPanels: 5,
    achievements: 150,
    applicationForms: 30,
    applicationPanels: 15,
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
    : `Remove one first, since ${tier} is the highest tier.`;
}

export function checkLimit(tier: EntitlementTier, key: LimitKey, current: number): LimitCheck {
  const limit = limitFor(tier, key);
  if (current < limit) return { ok: true };

  return {
    ok: false,
    limit,
    tier,
    humanReason:
      `The ${tier} tier allows ${limit} ${LIMIT_LABELS[key]}, and ${subject(key)} ` +
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
      `The ${tier} tier allows ${limit} ${LIMIT_LABELS[key]}, and this would save ${length}. ` +
      advice(tier, key),
  };
}
