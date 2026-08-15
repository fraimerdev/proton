import type { DbHandle } from './client.ts';

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
  levelForXp(xp: number): number;

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

  async award(input: MemberXpAwardInput): Promise<MemberXpAwardResult> {
    const now = new Date(input.now).toISOString();
    const cutoff = new Date(input.now - input.cooldownMs).toISOString();

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

    if (!row) throw new Error('members upsert returned no row, which should not be possible');

    return await this.#result(input.guildId, input.userId, row, row.awarded ? input.amount : 0);
  }

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

  async #cacheLevel(guildId: string, userId: string, cached: number, level: number): Promise<void> {
    if (cached === level) return;

    await this.#handle.client`
      update members
         set level = ${level}
       where guild_id = ${guildId} and user_id = ${userId} and level <> ${level}
    `;
  }
}
