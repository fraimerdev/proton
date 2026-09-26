import type { TierId } from '../events/achievements.ts';
import { PROTON_SUPPORT_URL } from './shared/bot.ts';
import type { BotFacts, MemberFacts, ServerFacts, UserFacts } from './shared/facts.ts';

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

export const SAMPLE_IDS = [
  'member',
  'level_up',
  'ticket_opened',
  'ticket_closed',
  'giveaway_winner',
  'tempvc',
  'report',
  'punishment',
  'achievement',
] as const;

export type SampleId = (typeof SAMPLE_IDS)[number];

export const SAMPLE_NOW = Date.UTC(2026, 8, 14, 9);

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) frozen(nested);
    Object.freeze(value);
  }
  return value;
}

export interface SampleMember {
  user: UserFacts;
  member: MemberFacts;
}

export const SAMPLE_SERVER: ServerFacts = frozen({
  id: '100000000000000001',
  name: 'Proton HQ',
  memberCount: 1204,
  ownerId: '100000000000000002',
  roleCount: 24,
  channelCount: 40,
  iconHash: null,
  bannerHash: null,
  description: 'Sample server',
  boostCount: 14,
  boostTier: 2,
});

export const SAMPLE_MEMBER: SampleMember = frozen({
  user: { id: '100000000000000010', username: 'fraimer', globalName: 'Fraimer', avatarHash: null },
  member: {
    nick: null,
    joinedAt: '2026-09-14T09:00:00.000Z',
    premiumSince: null,
    roleIds: ['100000000000000020'],
  },
});

export const SAMPLE_REPORTER: SampleMember = frozen({
  user: { id: '100000000000000011', username: 'nova', globalName: 'Nova', avatarHash: null },
  member: {
    nick: null,
    joinedAt: '2025-03-02T18:30:00.000Z',
    premiumSince: null,
    roleIds: [],
  },
});

export const SAMPLE_LEVEL_UP = frozen({
  previous: 4,
  level: 5,
  xp: 1234,
  gained: 23,
  rank: 12,
  rankedMemberCount: 480,
  messages: 812,
  voiceSeconds: 18000,
  source: 'message' as const,
});

export const SAMPLE_TICKET_OPEN = frozen({
  number: 42,
  typeName: 'Billing',
  openedAt: SAMPLE_NOW - 2 * HOUR,
  priority: 'medium' as const,
  subject: 'Refund for order 1182',
  answers: [{ key: 'order', label: 'Order number', value: '1182' }],
  claimedById: null as string | null,
});

export const SAMPLE_TICKET_CLOSED = frozen({
  ...SAMPLE_TICKET_OPEN,
  closedAt: SAMPLE_NOW,
  closedById: '100000000000000030',
  closeReason: 'Refund issued',
});

export const SAMPLE_GIVEAWAY_WIN = frozen({
  title: 'Nitro Classic',
  prize: 'Nitro Classic',
  winnerIndex: 1,
  winnerCount: 3,
  claimDeadline: SAMPLE_NOW + DAY,
  messageUrl:
    'https://discord.com/channels/100000000000000001/100000000000000040/100000000000000050',
});

export const SAMPLE_TEMPVC = frozen({
  hubName: 'Create a room',
  occupants: 3,
  owner: SAMPLE_MEMBER,
});

const SAMPLE_REWARD_ROLE_ID = '100000000000000021';

interface SampleAchievementReward {
  kind: 'add_role' | 'remove_role' | 'xp';
  roleId?: string;
  amount?: number;
}

export const SAMPLE_ACHIEVEMENT = frozen({
  member: {
    user: SAMPLE_MEMBER.user,
    member: { ...SAMPLE_MEMBER.member, joinedAt: '2025-11-02T17:45:00.000Z' },
  } satisfies SampleMember,
  achievement: {
    id: 'chatterbox',
    name: 'Chatterbox',
    description: 'Keep the conversation going in Proton HQ.',
    kind: 'tiered' as 'single' | 'tiered',
    tierCount: 4,
  },
  tier: 'gold' as TierId,
  tiersUnlocked: ['bronze', 'silver', 'gold'] as TierId[],
  requirements: [
    {
      trigger: 'messages.sent',
      label: 'Send messages',
      current: 1_000,
      target: 1_000,
      unit: { one: 'message', many: 'messages' },
    },
  ],
  next: { tier: 'diamond' as TierId, target: 5_000 },
  rewardRole: { id: SAMPLE_REWARD_ROLE_ID, name: 'Regular' },
  rewards: {
    granted: [
      { kind: 'add_role', roleId: SAMPLE_REWARD_ROLE_ID },
      { kind: 'xp', amount: 250 },
    ] as SampleAchievementReward[],
    pending: [] as SampleAchievementReward[],
    failed: [] as SampleAchievementReward[],
  },
  unlockedAt: SAMPLE_NOW,
  deadline: null as number | null,
  earnedCount: 5,
});

export const SAMPLE_BOT: BotFacts = frozen({
  id: '100000000000000099',
  name: 'Proton',
  avatarHash: null,
  websiteUrl: 'https://prtn.xyz',
  supportUrl: PROTON_SUPPORT_URL,
});

export interface SampleContext {
  now: number;
  server: ServerFacts;
  bot: BotFacts;
  member: SampleMember;
}

export const SAMPLE_CONTEXT: SampleContext = frozen({
  now: SAMPLE_NOW,
  server: SAMPLE_SERVER,
  bot: SAMPLE_BOT,
  member: SAMPLE_MEMBER,
});
