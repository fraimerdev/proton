/**
 * Where a member's XP lives.
 *
 * A port declared by the module rather than by `packages/core`, because §7 gives
 * a module its own storage in principle but `ModuleContext` carries a config, an
 * executor and a logger and nothing else — the same gap `createLoggingModule`
 * works around with its message-log store and `createVerificationModule` with
 * its quarantine records. The Drizzle implementation is
 * `packages/db/src/member-xp-store.ts`, which satisfies this interface
 * structurally: `packages/db` must not import a module, so it cannot name the
 * type it implements. `test/port.test.ts` asserts the two have not drifted.
 *
 * The table is `members`, declared in §6 and unused since Gate 0.
 */

/** Milliseconds since the epoch — always an event's `occurredAt`, never a clock. */
export type Instant = number;

export interface AwardInput {
  guildId: string;
  userId: string;
  /** XP to add. Rolled per message inside the configured min/max. */
  amount: number;
  /** How long since the last award before another one is allowed. */
  cooldownMs: number;
  /**
   * The moment the message was sent, not the moment it was processed.
   *
   * The cooldown is evaluated against this rather than against `now()` in
   * Postgres, so a bus backlog cannot compress a member's messages into one
   * cooldown window, and replaying a fixture gives the same answer twice.
   */
  now: Instant;
}

export interface VoiceCreditInput {
  guildId: string;
  userId: string;
  amount: number;
  /** Seconds of the closed voice session, added to `members.voice_seconds`. */
  seconds: number;
  now: Instant;
}

/** What `/xp` does to a member's total. */
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
  /** The member's total after the write. */
  xp: number;
  level: number;
  /**
   * The level before the write, so the caller can tell a level-up from an
   * ordinary award without a second read — and, crucially, without a
   * read-modify-write, which is the thing `award` exists to avoid.
   */
  previousLevel: number;
  /** False when the cooldown suppressed the award. Everything else is unchanged. */
  awarded: boolean;
}

export interface MemberXpRecord {
  userId: string;
  xp: number;
  level: number;
  /** 1-based position in the guild, ties broken by user id so it is stable. */
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
  /**
   * Add XP unless the member is still inside their cooldown.
   *
   * **One SQL statement**, and the requirement is not stylistic: the cooldown
   * check and the increment have to happen under the same lock or two messages
   * arriving together both read "no recent award" and both pay out. A
   * read-modify-write in application code looks correct, passes every test
   * written against one message at a time, and quietly doubles XP on exactly the
   * guilds busy enough to notice.
   */
  award(input: AwardInput): Promise<AwardResult>;

  /**
   * Pay out a closed voice session.
   *
   * No cooldown: the session itself is the window, and paying once per session
   * is enforced upstream by `VoiceSessionStore.close` handing the session to
   * exactly one caller. Deliberately does **not** touch `last_xp_at` — that
   * column is the message cooldown, and moving it would mean sitting in voice
   * silenced a member's chat XP.
   */
  creditVoice(input: VoiceCreditInput): Promise<AwardResult>;

  /** `/xp give|take|set`. No cooldown, and never below zero or above `MAX_XP`. */
  adjust(input: AdjustInput): Promise<AwardResult>;

  /** One member, with their rank. Null when they have never earned anything. */
  get(guildId: string, userId: string): Promise<MemberXpRecord | null>;

  /**
   * The top of the guild, highest first.
   *
   * Members with no XP are left out: a leaderboard that lists everyone who ever
   * spoke, at zero, is a member list.
   */
  leaderboard(guildId: string, options: LeaderboardOptions): Promise<LeaderboardEntry[]>;
}
