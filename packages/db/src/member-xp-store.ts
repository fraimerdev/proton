import type { Causation } from '@proton/core';
import type { DbHandle } from './client.ts';

type AwardRow = { xp: number; level: number; awarded: boolean };
type GrantRow = {
  previous_level: number;
  level: number;
  xp_after: number;
  duplicate: boolean;
  cached_level: number | null;
};
type StoredGrantRow = { previous_level: number; level: number; xp_after: number };
type AdjustRow = { xp: number; level: number; previous_xp: number };
type RecordRow = {
  xp: number;
  level: number;
  rank: number;
  message_count: number;
  voice_seconds: number;
};
type LeaderRow = { user_id: string; xp: number };
type CountRow = { ranked: number };

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

export interface MemberXpGrantInput {
  guildId: string;
  userId: string;
  amount: number;
  grantId: string;
  sourceModule: string;
  causation: Causation;
  now: number;
}

export interface MemberXpGrantResult extends MemberXpAwardResult {
  duplicate: boolean;
}

const UNIQUE_VIOLATION = '23505';

const XP_GRANTS_PKEY = 'xp_grants_guild_id_grant_id_pk';

function isGrantRace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { code, constraint_name: constraint } = error as {
    code?: unknown;
    constraint_name?: unknown;
  };

  return code === UNIQUE_VIOLATION && constraint === XP_GRANTS_PKEY;
}

function levelThresholds(levelForXp: (xp: number) => number, maxXp: number): number[] {
  const thresholds: number[] = [];
  const top = levelForXp(maxXp);

  let low = 0;
  for (let level = 1; level <= top; level += 1) {
    let high = maxXp;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (levelForXp(middle) >= level) high = middle;
      else low = middle + 1;
    }
    thresholds.push(low);
  }

  return thresholds;
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
  #thresholds: number[] | undefined;

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
      ), rolled as (
        insert into member_activity_daily as a (guild_id, user_id, day, message_count)
        select ${input.guildId}, ${input.userId},
               (${now}::timestamptz at time zone 'utc')::date, 1
         where exists (select 1 from awarded)
        on conflict (guild_id, user_id, day) do update
           set message_count = a.message_count + 1
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

    const now = new Date(input.now).toISOString();

    const rows = await this.#handle.client<AwardRow[]>`
      with credited as (
        insert into members as m (guild_id, user_id, xp, level, voice_seconds)
             values (${input.guildId}, ${input.userId}, ${input.amount}, ${insertLevel},
                     ${input.seconds})
        on conflict (guild_id, user_id) do update
           set xp = m.xp + ${input.amount},
               voice_seconds = m.voice_seconds + ${input.seconds}
        returning m.xp as xp, m.level as level, true as awarded
      ), rolled as (
        insert into member_activity_daily as a (guild_id, user_id, day, voice_seconds)
        select ${input.guildId}, ${input.userId},
               (${now}::timestamptz at time zone 'utc')::date, ${input.seconds}
         where exists (select 1 from credited)
        on conflict (guild_id, user_id, day) do update
           set voice_seconds = a.voice_seconds + ${input.seconds}
      )
      select xp, level, awarded from credited
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

  async grant(input: MemberXpGrantInput): Promise<MemberXpGrantResult> {
    try {
      return await this.#grant(input);
    } catch (error) {
      if (!isGrantRace(error)) throw error;

      const stored = await this.#storedGrant(input.guildId, input.grantId);
      if (!stored) throw error;
      return stored;
    }
  }

  async #grant(input: MemberXpGrantInput): Promise<MemberXpGrantResult> {
    const amount = this.#clamp(input.amount);
    const now = new Date(input.now).toISOString();
    this.#thresholds ??= levelThresholds(this.#levelForXp, this.#maxXp);

    // Levels come from the module's curve as thresholds, so credit and ledger share one statement.
    const rows = await this.#handle.client<GrantRow[]>`
      with recorded as (
        select previous_level, level, xp_after
          from xp_grants
         where guild_id = ${input.guildId} and grant_id = ${input.grantId}
      ), before as (
        select xp from members where guild_id = ${input.guildId} and user_id = ${input.userId}
      ), credited as (
        insert into members as m (guild_id, user_id, xp, level)
        select ${input.guildId}, ${input.userId}, ${amount}, ${this.#levelForXp(amount)}
         where not exists (select 1 from recorded)
        on conflict (guild_id, user_id) do update
           set xp = least(${this.#maxXp}::int, m.xp + ${amount}::int)
        returning m.xp as xp_after, m.level as cached_level
      ), grown as (
        select xp_after, cached_level,
               case when xp_after < ${this.#maxXp}::int then xp_after - ${amount}::int
                    else greatest(${this.#maxXp}::int - ${amount}::int,
                                  coalesce((select xp from before), 0))
               end as xp_before
          from credited
      ), ledger as (
        insert into xp_grants (guild_id, grant_id, user_id, amount, source_module, causation,
                               previous_level, level, xp_after, created_at)
        select ${input.guildId}, ${input.grantId}, ${input.userId}, ${amount},
               ${input.sourceModule}, ${JSON.stringify(input.causation)}::jsonb,
               (select count(*) from unnest(${this.#thresholds}::int[]) as curve(xp)
                 where curve.xp <= grown.xp_before)::int,
               (select count(*) from unnest(${this.#thresholds}::int[]) as curve(xp)
                 where curve.xp <= grown.xp_after)::int,
               grown.xp_after, ${now}::timestamptz
          from grown
        returning previous_level, level, xp_after
      )
      select l.previous_level, l.level, l.xp_after, false as duplicate,
             (select cached_level from credited) as cached_level
        from ledger l
      union all
      select previous_level, level, xp_after, true as duplicate, null as cached_level
        from recorded
    `;

    const row = rows[0];
    if (!row) throw new Error('xp grant wrote no ledger row and found none, which cannot happen');

    if (!row.duplicate && row.cached_level !== null) {
      await this.#cacheLevel(input.guildId, input.userId, row.cached_level, row.level);
    }

    return {
      xp: row.xp_after,
      level: row.level,
      previousLevel: row.previous_level,
      awarded: !row.duplicate,
      duplicate: row.duplicate,
    };
  }

  async #storedGrant(guildId: string, grantId: string): Promise<MemberXpGrantResult | null> {
    const rows = await this.#handle.client<StoredGrantRow[]>`
      select previous_level, level, xp_after
        from xp_grants
       where guild_id = ${guildId} and grant_id = ${grantId}
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      xp: row.xp_after,
      level: row.level,
      previousLevel: row.previous_level,
      awarded: false,
      duplicate: true,
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

  async countRanked(guildId: string): Promise<number> {
    const rows = await this.#handle.client<CountRow[]>`
      select count(*)::int as ranked
        from members
       where guild_id = ${guildId} and xp > 0
    `;

    return rows[0]?.ranked ?? 0;
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
