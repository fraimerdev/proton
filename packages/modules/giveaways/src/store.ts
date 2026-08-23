import type { EntryBreakdown, MultiplierMode } from '@proton/core';

export const GIVEAWAY_STATUSES = ['scheduled', 'running', 'drawing', 'ended', 'cancelled'] as const;

export type GiveawayStatus = (typeof GIVEAWAY_STATUSES)[number];

export const REQUIREMENT_LOGICS = ['any', 'all'] as const;
export type RequirementLogic = (typeof REQUIREMENT_LOGICS)[number];

export const VERIFY_ON = ['join', 'draw', 'both'] as const;
export type VerifyOn = (typeof VERIFY_ON)[number];

export const BLACKLIST_SUBJECTS = ['user', 'role'] as const;
export type BlacklistSubject = (typeof BLACKLIST_SUBJECTS)[number];

export interface RequirementRow {
  id: string;
  providerId: string;
  config: unknown;
  position: number;
}

export interface MultiplierRow extends RequirementRow {
  mode: MultiplierMode;
}

export interface Giveaway {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;

  title: string;
  description: string | null;
  bannerUrl: string | null;
  color: number | null;
  emoji: string | null;
  buttonStyle: number;

  winnerCount: number;
  requirementLogic: RequirementLogic;
  maxEntriesPerUser: number | null;
  verifyOn: VerifyOn;

  startsAt: Date | null;
  endsAt: Date;
  endedAt: Date | null;

  status: GiveawayStatus;
  drawingStartedAt: Date | null;

  claimWindowSeconds: number | null;
  dmWinners: boolean;
  winMessage: string | null;

  templateId: string | null;
  recurrence: string | null;

  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGiveawayInput {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;

  title: string;
  description?: string | null;
  bannerUrl?: string | null;
  color?: number | null;
  emoji?: string | null;
  buttonStyle?: number;

  winnerCount: number;
  requirementLogic?: RequirementLogic;
  maxEntriesPerUser?: number | null;
  verifyOn?: VerifyOn;

  startsAt?: Date | null;
  endsAt: Date;
  status?: GiveawayStatus;

  claimWindowSeconds?: number | null;
  dmWinners?: boolean;
  winMessage?: string | null;

  templateId?: string | null;
  recurrence?: string | null;

  createdBy: string;

  requirements?: readonly Omit<RequirementRow, 'id'>[];
  multipliers?: readonly Omit<MultiplierRow, 'id'>[];
}

export type GiveawayState = 'running' | 'ended' | 'any';

export interface ListGiveawaysQuery {
  guildId: string;
  state: GiveawayState;
  limit: number;
  prefix?: string;
}

export interface MemberSnapshot {
  roleIds: string[] | null;
  joinedAt: string | null;
  premiumSince: string | null;
  hasAvatar: boolean | null;
}

export interface NewEntry {
  giveawayId: string;
  userId: string;
  baseEntries: number;
  totalEntries: number;
  breakdown: EntryBreakdown[];
  memberSnapshot: MemberSnapshot | null;
}

export type EnterOutcome = 'entered' | 'already-entered';

export interface EntrantRow {
  userId: string;
  totalEntries: number;
  memberSnapshot: MemberSnapshot | null;
}

export interface Disqualification {
  userId: string;
  reason: string;
}

export interface Reweigh {
  userId: string;
  totalEntries: number;
  breakdown: EntryBreakdown[];
}

export interface DrawRecord {
  id: string;
  giveawayId: string;
  drawNumber: number;
  seed: string;
  snapshotHash: string;
  entrantCount: number;
  totalEntries: number;
  winnerIds: string[];
  degradedProviders: string[];
  drawnAt: Date;
  drawnBy: string;
  reason: string | null;
}

export interface RecordDrawInput {
  id: string;
  giveawayId: string;
  drawNumber: number;
  seed: string;
  snapshotHash: string;
  entrantCount: number;
  totalEntries: number;
  winnerIds: readonly string[];
  degradedProviders: readonly string[];
  drawnBy: string;
  reason?: string | null;
  claimDeadline?: Date | null;
}

export interface WinRecord {
  giveawayId: string;
  drawId: string;
  userId: string;
  claimedAt: Date | null;
  forfeitedAt: Date | null;
  rerolledAt: Date | null;
  claimDeadline: Date | null;
}

export interface BlacklistEntry {
  subjectType: BlacklistSubject;
  subjectId: string;
  addedBy: string;
  reason: string | null;
}

export interface TemplateRecord {
  id: string;
  guildId: string;
  name: string;
  payload: unknown;
  createdBy: string;
  createdAt: Date;
}

export interface GiveawayStore {
  create(input: CreateGiveawayInput): Promise<Giveaway>;
  get(guildId: string, giveawayId: string): Promise<Giveaway | null>;
  byMessage(guildId: string, messageId: string): Promise<Giveaway | null>;
  list(query: ListGiveawaysQuery): Promise<Giveaway[]>;
  countRunning(guildId: string): Promise<number>;
  setMessageId(giveawayId: string, messageId: string): Promise<void>;

  requirements(giveawayId: string): Promise<RequirementRow[]>;
  multipliers(giveawayId: string): Promise<MultiplierRow[]>;

  // Insert and let the composite primary key refuse the second row: a read-then-insert lets two
  // presses a millisecond apart both pass the read, and the member is entered twice.
  enter(entry: NewEntry): Promise<EnterOutcome>;
  entry(giveawayId: string, userId: string): Promise<EntrantRow | null>;
  entrantCount(giveawayId: string): Promise<number>;
  entrantCounts(giveawayIds: readonly string[]): Promise<Map<string, number>>;

  /** Ordered by user_id ascending — the draw is order-sensitive and its audit row depends on it. */
  entrants(giveawayId: string, chunkSize: number): AsyncIterable<EntrantRow[]>;

  /** Heaviest entries first, for the host's view of who is most likely to win. */
  topEntrants(giveawayId: string, limit: number): Promise<EntrantRow[]>;

  disqualify(giveawayId: string, rows: readonly Disqualification[], at: Date): Promise<number>;
  reweigh(giveawayId: string, rows: readonly Reweigh[], at: Date): Promise<number>;

  /**
   * `update ... where status = 'running' returning *` — the conditional update IS the lock.
   * Exactly one caller gets a row; a concurrent end and a firing job cannot both proceed.
   */
  beginDraw(guildId: string, giveawayId: string, at: Date): Promise<Giveaway | null>;
  recordDraw(input: RecordDrawInput): Promise<{ drawId: string } | 'already-drawn'>;
  finishDraw(
    guildId: string,
    giveawayId: string,
    status: GiveawayStatus,
    endedAt: Date | null,
  ): Promise<boolean>;

  /**
   * Giveaways stuck in `drawing` past the threshold. `drawn` says whether the draw row actually
   * landed: if it did, the recovery finishes forward, and if it did not, the giveaway goes back to
   * `running` to be drawn again. Re-drawing one that already produced winners is the bug this
   * distinction exists to prevent.
   */
  stalledDraws(before: Date, limit: number): Promise<{ giveaway: Giveaway; drawn: boolean }[]>;
  releaseDraw(guildId: string, giveawayId: string): Promise<boolean>;
  overdue(before: Date, limit: number): Promise<Giveaway[]>;
  running(limit: number): Promise<Giveaway[]>;

  draws(giveawayId: string): Promise<DrawRecord[]>;
  lastDrawNumber(giveawayId: string): Promise<number>;
  winners(giveawayId: string): Promise<WinRecord[]>;
  claim(drawId: string, userId: string, at: Date): Promise<boolean>;
  forfeit(drawId: string, userIds: readonly string[], at: Date): Promise<number>;
  expiredClaims(before: Date, limit: number): Promise<WinRecord[]>;

  /** Powers giveaways.no_recent_wins — one statement for a whole batch of entrants. */
  recentWinCounts(
    guildId: string,
    userIds: readonly string[],
    since: Date,
    templateId?: string | null,
  ): Promise<Map<string, number>>;

  /** Powers giveaways.entered_before. */
  priorEntryCounts(
    guildId: string,
    userIds: readonly string[],
    since: Date,
  ): Promise<Map<string, number>>;

  blacklist(guildId: string): Promise<BlacklistEntry[]>;
  addBlacklist(guildId: string, entry: BlacklistEntry): Promise<boolean>;
  removeBlacklist(
    guildId: string,
    subjectType: BlacklistSubject,
    subjectId: string,
  ): Promise<boolean>;

  saveTemplate(input: Omit<TemplateRecord, 'createdAt'>): Promise<TemplateRecord>;
  template(guildId: string, name: string): Promise<TemplateRecord | null>;
  templates(guildId: string): Promise<TemplateRecord[]>;
  deleteTemplate(guildId: string, name: string): Promise<boolean>;
}
