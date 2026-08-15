import type { DbHandle } from './client.ts';

/**
 * Postgres implementation of the leveling module's `MemberXpStore`, against §6's
 * `members` table.
 *
 * It does not `implement` that interface, and cannot: the port is declared in
 * `packages/modules/leveling/src/store.ts`, and `packages/db` importing a module
 * would invert the dependency every other store here respects (the logging
 * module imports `DbHandle` from this package, not the other way round). The two
 * match structurally, and the module's `test/port.test.ts` assigns one to the
 * other so a drift is a compile error rather than a runtime surprise.
 *
 * Every statement below is raw SQL on `handle.client` rather than Drizzle's
 * query builder, because each one is a CTE that the builder cannot express —
 * and because the whole point of `award` is a shape (`INSERT … ON CONFLICT DO
 * UPDATE … WHERE`) that has to stay visible and reviewable rather than being
 * assembled from method calls. Timestamps therefore cross as ISO strings with an
 * explicit `::timestamptz` cast: `drizzle({ client })` replaces postgres.js's
 * timestamp serialisers on the shared connection, so a raw query handed a `Date`
 * throws. See `client.ts` and `scheduled-action-store.ts`.
 */

/** postgres.js hands back raw column names; the rows must satisfy its bound. */
type AwardRow = { xp: number; level: number; awarded: boolean };
type AdjustRow = { xp: number; level: number; previous_xp: number };
type RecordRow = {
  xp: number;
  level: number;
  rank: number;
  message_count: number;
  voice_seconds: number;
};
type LeaderRow = { user_id: string; xp: number };

export interface MemberXpStoreOptions {
  /**
   * The curve, injected.
   *
   * `levelForXp` is the leveling module's, and it is the only implementation
   * that exists — expressing the same inverse a second time in SQL would put a
   * float `sqrt()` and a TypeScript one in charge of the same boundary, and
   * "level 5 begins at 1 000 XP" would be true in one language and off by one in
   * the other. So the store computes levels with the caller's function and
   * treats `members.level` as a **cache for readers outside this store** (the
   * API, the dashboard, ad-hoc SQL): every level this store *returns* is derived
   * from `xp`, so a stale cached column can never change Proton's behaviour.
   */
  levelForXp(xp: number): number;

  /** Upper bound for `adjust`, so `/xp set` cannot overflow an int4 column. */
  maxXp: number;
}

export interface MemberXpAwardInput {
  guildId: string;
  userId: string;
  amount: number;
  cooldownMs: number;
  now: number;
}

export interface MemberXpVoiceInput {
  guildId: string;
  userId: string;
  amount: number;
  seconds: number;
  now: number;
}

export interface MemberXpAdjustInput {
  guildId: string;
  userId: string;
  adjustment: 'give' | 'take' | 'set';
  amount: number;
  now: number;
}

export interface MemberXpAwardResult {
  xp: number;
  level: number;
  previousLevel: number;
  awarded: boolean;
}

export interface MemberXpRecordResult {
  userId: string;
  xp: number;
  level: number;
  rank: number;
  messageCount: number;
  voiceSeconds: number;
}

export interface MemberXpLeaderboardEntry {
  userId: string;
  xp: number;
  level: number;
  rank: number;
}

export class DrizzleMemberXpStore {
  readonly #handle: DbHandle;
  readonly #levelForXp: (xp: number) => number;
  readonly #maxXp: number;

  constructor(handle: DbHandle, options: MemberXpStoreOptions) {
    this.#handle = handle;
    this.#levelForXp = options.levelForXp;
    this.#maxXp = options.maxXp;
  }

  /**
   * Award message XP, at most once per cooldown window.
   *
   * The statement is the whole design. `INSERT … ON CONFLICT (guild_id, user_id)
   * DO UPDATE … WHERE last_xp_at < cutoff` makes the cooldown check and the
   * increment one atomic act: Postgres takes the row lock before evaluating the
   * `WHERE`, so of two messages arriving in the same instant the second sees the
   * first's `last_xp_at` already committed and its update is suppressed. The
   * equivalent read-then-write in TypeScript has a window between the two halves
   * that is invisible in every single-message test and doubles XP on precisely
   * the guilds active enough to care.
   *
   * The `UNION ALL` arm exists because a suppressed `DO UPDATE` returns no row
   * at all, and the caller still needs to know where the member stands — an
   * award that says nothing is indistinguishable from a member who does not
   * exist. The `NOT EXISTS` guard means exactly one arm ever produces a row.
   *
   * `cutoff` is computed from the event's own timestamp rather than `now()` in
   * Postgres, so a redelivery or a fixture replay lands in the window it
   * originally occupied (I4, and the same reasoning as antiraid's join window).
   *
   * No clamp on the increment, unlike `adjust`: the config caps a single award
   * at three digits, so reaching int4's ceiling would take tens of millions of
   * awards against one member — while clamping here would make `xp − amount` the
   * wrong answer for the previous total, and that is what decides whether a
   * level-up fires.
   */
  async award(input: MemberXpAwardInput): Promise<MemberXpAwardResult> {
    const now = new Date(input.now).toISOString();
    const cutoff = new Date(input.now - input.cooldownMs).toISOString();
    // Only used by the INSERT arm, where the member is new and the total is
    // exactly `amount`. The conflict arm's level is repaired below.
    const insertLevel = this.#levelForXp(input.amount);

    const rows = await this.#handle.client<AwardRow[]>`
      with awarded as (
        insert into members as m (guild_id, user_id, xp, level, last_xp_at, message_count)
             values (${input.guildId}, ${input.userId}, ${input.amount}, ${insertLevel},
                     ${now}::timestamptz, 1)
        on conflict (guild_id, user_id) do update
           set xp = m.xp + ${input.amount},
               last_xp_at = ${now}::timestamptz,
               message_count = m.message_count + 1
         where m.last_xp_at is null or m.last_xp_at < ${cutoff}::timestamptz
        returning m.xp as xp, m.level as level, true as awarded
      )
      select xp, level, awarded from awarded
      union all
      select m.xp, m.level, false as awarded
        from members m
       where m.guild_id = ${input.guildId}
         and m.user_id = ${input.userId}
         and not exists (select 1 from awarded)
    `;

    const row = rows[0];
    // Unreachable: the insert arm creates the row when it is missing, so either
    // the award happened or the row was already there to report.
    if (!row) throw new Error('members upsert returned no row, which should not be possible');

    return await this.#result(input.guildId, input.userId, row, row.awarded ? input.amount : 0);
  }

  /**
   * Pay out a closed voice session.
   *
   * No cooldown clause, deliberately: the session is the window. Paying exactly
   * once is enforced a layer up, where closing the session and reading it are
   * one atomic Redis `GETDEL` — a second delivery of the same disconnect finds
   * nothing to close and never reaches here.
   *
   * `last_xp_at` is untouched. It is the *message* cooldown, and advancing it
   * from voice would mean an hour in a voice channel silently suppressed the
   * member's next chat award.
   */
  async creditVoice(input: MemberXpVoiceInput): Promise<MemberXpAwardResult> {
    const insertLevel = this.#levelForXp(input.amount);

    const rows = await this.#handle.client<AwardRow[]>`
      insert into members as m (guild_id, user_id, xp, level, voice_seconds)
           values (${input.guildId}, ${input.userId}, ${input.amount}, ${insertLevel},
                   ${input.seconds})
      on conflict (guild_id, user_id) do update
         set xp = m.xp + ${input.amount},
             voice_seconds = m.voice_seconds + ${input.seconds}
      returning m.xp as xp, m.level as level, true as awarded
    `;

    const row = rows[0];
    if (!row) throw new Error('members upsert returned no row, which should not be possible');

    return await this.#result(input.guildId, input.userId, row, input.amount);
  }

  /**
   * `/xp give|take|set`.
   *
   * Clamped into `[0, maxXp]` in SQL rather than in the handler, so a moderator
   * taking 500 XP from a member who has 200 leaves them at zero instead of at a
   * negative total that the curve would have to be taught to interpret.
   *
   * The `before` CTE reads the pre-write total from the same statement snapshot,
   * which is what makes `previousLevel` meaningful for an absolute `set` — there
   * is no `xp − amount` to work backwards from. Two moderators adjusting the
   * same member in the same instant is not a race worth designing around; the
   * writes still serialise, only the reported "before" could be one of two
   * truthful answers.
   */
  async adjust(input: MemberXpAdjustInput): Promise<MemberXpAwardResult> {
    const initialXp = this.#clamp(input.adjustment === 'take' ? 0 : input.amount);

    const rows = await this.#handle.client<AdjustRow[]>`
      with before as (
        select xp from members where guild_id = ${input.guildId} and user_id = ${input.userId}
      ), adjusted as (
        insert into members as m (guild_id, user_id, xp, level)
             values (${input.guildId}, ${input.userId}, ${initialXp},
                     ${this.#levelForXp(initialXp)})
        on conflict (guild_id, user_id) do update
           set xp = greatest(0, least(${this.#maxXp}, case ${input.adjustment}::text
                     when 'give' then m.xp + ${input.amount}
                     when 'take' then m.xp - ${input.amount}
                     else ${input.amount} end))
        returning m.xp as xp, m.level as level
      )
      select a.xp, a.level, coalesce((select xp from before), 0) as previous_xp
        from adjusted a
    `;

    const row = rows[0];
    if (!row) throw new Error('members upsert returned no row, which should not be possible');

    const level = this.#levelForXp(row.xp);
    await this.#cacheLevel(input.guildId, input.userId, row.level, level);

    return {
      xp: row.xp,
      level,
      previousLevel: this.#levelForXp(row.previous_xp),
      awarded: true,
    };
  }

  /**
   * One member and their standing.
   *
   * Rank is "how many are ahead of you, plus one", with ties broken by user id
   * so that two members on identical XP get distinct, stable ranks rather than
   * swapping places on every refresh. The same tie-break orders `leaderboard`,
   * so a member's rank and their row on the board agree.
   */
  async get(guildId: string, userId: string): Promise<MemberXpRecordResult | null> {
    const rows = await this.#handle.client<RecordRow[]>`
      select m.xp,
             m.level,
             m.message_count,
             m.voice_seconds,
             (1 + (select count(*)
                     from members r
                    where r.guild_id = m.guild_id
                      and (r.xp > m.xp or (r.xp = m.xp and r.user_id < m.user_id))))::int as rank
        from members m
       where m.guild_id = ${guildId} and m.user_id = ${userId}
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      userId,
      xp: row.xp,
      level: this.#levelForXp(row.xp),
      rank: row.rank,
      messageCount: row.message_count,
      voiceSeconds: row.voice_seconds,
    };
  }

  /**
   * A page of the guild's board.
   *
   * `xp > 0` keeps members who have never earned anything off it — every member
   * of the guild is a member list, not a leaderboard. The index added by
   * `0004_leveling.sql` covers `(guild_id, xp desc)`, which is this query and the
   * only query this table is read by at volume.
   */
  async leaderboard(
    guildId: string,
    options: { limit: number; offset: number },
  ): Promise<MemberXpLeaderboardEntry[]> {
    const rows = await this.#handle.client<LeaderRow[]>`
      select user_id, xp
        from members
       where guild_id = ${guildId} and xp > 0
       order by xp desc, user_id asc
       limit ${options.limit} offset ${options.offset}
    `;

    return rows.map((row, index) => ({
      userId: row.user_id,
      xp: row.xp,
      level: this.#levelForXp(row.xp),
      rank: options.offset + index + 1,
    }));
  }

  #clamp(xp: number): number {
    return Math.max(0, Math.min(this.#maxXp, Math.trunc(xp)));
  }

  /**
   * Derive the level from the returned total and refresh the cached column when
   * they disagree.
   *
   * `added` is what the statement actually put in, so the previous total is a
   * subtraction rather than a second read — which is what keeps the award to one
   * statement on the hot path.
   */
  async #result(
    guildId: string,
    userId: string,
    row: AwardRow,
    added: number,
  ): Promise<MemberXpAwardResult> {
    const level = this.#levelForXp(row.xp);
    await this.#cacheLevel(guildId, userId, row.level, level);

    return {
      xp: row.xp,
      level,
      previousLevel: this.#levelForXp(row.xp - added),
      awarded: row.awarded,
    };
  }

  /**
   * Keep `members.level` in step with `members.xp`.
   *
   * A separate statement, and deliberately not part of the award: the level is a
   * function of the XP, so writing it requires knowing the *new* total, which
   * only exists once the award has run. Expressing the curve's inverse a second
   * time in SQL to fold it in would put two implementations of one formula in
   * charge of the same boundary — the trade the module refuses in
   * `MemberXpStoreOptions`.
   *
   * It is cheap because it is rare (a member levels up once per level, not once
   * per message) and skipped entirely when nothing changed. It is safe because
   * it is idempotent and derived: a lost write leaves a stale cache that nothing
   * in Proton reads, and the next award repairs it.
   */
  async #cacheLevel(guildId: string, userId: string, cached: number, level: number): Promise<void> {
    if (cached === level) return;

    await this.#handle.client`
      update members
         set level = ${level}
       where guild_id = ${guildId} and user_id = ${userId} and level <> ${level}
    `;
  }
}
