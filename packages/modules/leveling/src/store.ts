export type Instant = number;

export interface AwardInput {
  guildId: string;
  userId: string;

  amount: number;

  cooldownMs: number;

  now: Instant;
}

export interface VoiceCreditInput {
  guildId: string;
  userId: string;
  amount: number;

  seconds: number;
  now: Instant;
}

export const XP_ADJUSTMENTS = ['give', 'take', 'set'] as const;

export type XpAdjustment = (typeof XP_ADJUSTMENTS)[number];

export interface AdjustInput {
  guildId: string;
  userId: string;
  adjustment: XpAdjustment;
  amount: number;
  now: Instant;
}

export interface AwardResult {
  xp: number;
  level: number;

  previousLevel: number;

  awarded: boolean;
}

export interface MemberXpRecord {
  userId: string;
  xp: number;
  level: number;

  rank: number;
  messageCount: number;
  voiceSeconds: number;
}

export interface LeaderboardEntry {
  userId: string;
  xp: number;
  level: number;
  rank: number;
}

export interface LeaderboardOptions {
  limit: number;
  offset: number;
}

export interface MemberXpStore {
  /** Must be one SQL statement, cooldown included, or concurrent messages double-award. */
  award(input: AwardInput): Promise<AwardResult>;

  creditVoice(input: VoiceCreditInput): Promise<AwardResult>;

  adjust(input: AdjustInput): Promise<AwardResult>;

  get(guildId: string, userId: string): Promise<MemberXpRecord | null>;

  leaderboard(guildId: string, options: LeaderboardOptions): Promise<LeaderboardEntry[]>;
}
