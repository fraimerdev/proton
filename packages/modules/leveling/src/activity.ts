export const ACTIVITY_WINDOWS = ['lifetime', '7d', '30d'] as const;

export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number];

export const ACTIVITY_WINDOW_DAYS: Record<ActivityWindow, number | null> = {
  lifetime: null,
  '7d': 7,
  '30d': 30,
};

// One day wider than the widest window offered, so a 30d question never reads a bucket the
// pruner has already taken away.
export const ACTIVITY_RETENTION_DAYS = 31;

export interface ActivityTotals {
  messageCount: number;
  voiceSeconds: number;
}

export interface MemberStats {
  xp: number;
  level: number;
  messageCount: number;
  voiceSeconds: number;
}

export interface ActivityQuery {
  guildId: string;
  userIds: readonly string[];
  window: ActivityWindow;
  now: Date;
}

export interface ChannelActivityQuery extends ActivityQuery {
  channelIds: readonly string[];
}

export interface ActivityStore {
  /** One statement for every member asked about — never one query per member. */
  totals(query: ActivityQuery): Promise<Map<string, ActivityTotals>>;

  stats(guildId: string, userIds: readonly string[]): Promise<Map<string, MemberStats>>;

  /** The leaderboard's top n user ids, highest first. */
  topRanked(guildId: string, n: number): Promise<string[]>;

  prune(before: Date): Promise<number>;
}

export function windowStart(window: ActivityWindow, now: Date): Date | null {
  const days = ACTIVITY_WINDOW_DAYS[window];
  if (days === null) return null;

  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
