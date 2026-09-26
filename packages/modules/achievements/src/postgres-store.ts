import { ACHIEVEMENT_JOBS, TIER_IDS, type TierId } from '@proton/core';
import type { DbHandle, NewAuditTrailEntry } from '@proton/db';
import { and, sql as drizzleSql, eq, lt, notInArray } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { ActivityRecord } from './activity.ts';
import { achievementsConfigSchema, MODULE_ID } from './config.ts';
import {
  ACTIVE_DAY_TARGET_METRIC,
  ACTIVITY_RETENTION_DAYS,
  GROUP_RELEASE_METRIC,
  JOB_SLICE,
  MAX_REWARD_ATTEMPTS,
  RESERVED_SEEN_RETENTION_MS,
  SEEN_RETENTION_MS,
  XP_CONFIRM_TIMEOUT_MS,
} from './constants.ts';
import { type Interval, rewardKeyOf } from './evaluate.ts';
import {
  type RebuildMemberInput,
  type RebuildOutcome,
  rebuildOutcome,
  rebuildRequirementsJson,
  rebuildSignature,
  rebuildWindowsJson,
} from './rebuild.ts';
import {
  type AchievementMembersCount,
  type AchievementRuntimeState,
  type AchievementStore,
  ALREADY_GIVEN,
  type AnniversaryWindow,
  type AnnounceGroup,
  type AnnouncementClaim,
  type AnnouncementOutcome,
  type BadgeAsset,
  CANCELLED_BY_RESET,
  type DueWork,
  type FactsPatch,
  type GuildRuntime,
  type JobPatch,
  type JobState,
  type MemberAchievementState,
  type MemberDetailRows,
  type MemberFacts,
  NO_NEWLY_EARNED,
  type Page,
  type PendingOrigin,
  type ProgressTarget,
  type PurgeResult,
  parseXpGrantId,
  RESET_BEFORE_ANNOUNCED,
  type RebuildMode,
  type RebuildPlan,
  type RebuildSliceResult,
  type RecordResult,
  type ResetAchievementInput,
  type ResetMemberInput,
  type RewardClaim,
  type RewardOutcome,
  type RewardRef,
  type RewardRow,
  type RewardStatusCount,
  type StateValue,
  type TierHolders,
  type UnlockInput,
  type UnlockResult,
  type UnlockRow,
  XP_REFUSED,
  type XpGrantOutcome,
} from './store.ts';
import { achievementBadges, achievementMemberFacts, achievementState } from './table.ts';
import { LEDGER_METRICS, type LedgerMetric, REWARD_KIND_IDS } from './triggers.ts';
import {
  ANNOUNCE_STATUSES,
  JOB_STATUSES,
  jobResultSchema,
  REWARD_STATUSES,
  type RewardListQuery,
  type UnlockListQuery,
  unlockCauseSchema,
  unlockDefinitionSchema,
  unlockProgressSchema,
} from './view.ts';

type Client = DbHandle['client'];
type Tx = Parameters<Parameters<Client['begin']>[1]>[0];
type Query = Client | Tx;

const DAY_MS = 24 * 60 * 60 * 1000;
const FACTS_AFTER_LEAVING_MS = 30 * DAY_MS;

const MODULE_ROW = '';

interface UnlockDbRow {
  guild_id: string;
  user_id: string;
  achievement_id: string;
  tier_id: string;
  generation: number;
  tier_index: number;
  unlocked_at_ms: number;
  revision: string;
  definition: unknown;
  progress: unknown;
  cause: unknown;
  origin_channel_id: string | null;
  announce_group: string;
  announce_status: string;
  announce_attempts: number;
  announce_lease_until_ms: number | null;
  announce_error: string | null;
  announced_at_ms: number | null;
  announce_message_id: string | null;
  published_at_ms: number | null;
  voided_at_ms: number | null;
  voided_by: string | null;
}

interface RewardDbRow {
  guild_id: string;
  user_id: string;
  achievement_id: string;
  tier_id: string;
  generation: number;
  reward_key: string;
  reward_epoch: number;
  kind: string;
  role_id: string | null;
  amount: number | null;
  status: string;
  attempts: number;
  lease_until_ms: number | null;
  next_attempt_at_ms: number | null;
  transient: boolean;
  error_code: string | null;
  error: string | null;
  requested_at_ms: number | null;
  delivered_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface StateDbRow {
  achievement_id: string | null;
  generation: number;
  reward_epoch: number;
  counted_from_ms: number | null;
  almost_notified: unknown;
  almost_notified_at_ms: number | null;
  progress: unknown;
  unlocked: unknown;
}

interface FactsDbRow {
  user_id: string;
  joined_at_ms: number | null;
  premium_since_ms: number | null;
  left_at_ms: number | null;
  updated_at_ms: number;
}

const progressEntrySchema = z.tuple([z.string(), z.number(), z.number(), z.number()]);

const moduleBagSchema = z.object({
  anniversaryRunAt: z.number().optional(),
  rebuilt: z.record(z.string(), z.string()).optional(),
});

function iso(at: number): string {
  return new Date(at).toISOString();
}

function dated(at: number | null): Date | null {
  return at === null ? null : new Date(at);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ms(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(value);
}

function msOf(value: number | null | undefined, what: string): number {
  const at = ms(value);
  if (at === null) throw new Error(`${what} came back empty from the database`);
  return at;
}

function member<T extends string>(values: readonly T[], value: unknown, what: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`${what} "${String(value)}" is not one Proton knows, so the row can’t be read`);
  }
  return found;
}

function tierIds(value: unknown): TierId[] {
  const list = Array.isArray(value) ? value : [];
  return TIER_IDS.filter((tier) => list.includes(tier));
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function unlockColumns(sql: Query) {
  return sql`
    guild_id, user_id, achievement_id, tier_id, generation, tier_index,
    (extract(epoch from unlocked_at) * 1000)::float8 as unlocked_at_ms,
    revision, definition, progress, cause, origin_channel_id, announce_group, announce_status,
    announce_attempts,
    (extract(epoch from announce_lease_until) * 1000)::float8 as announce_lease_until_ms,
    announce_error,
    (extract(epoch from announced_at) * 1000)::float8 as announced_at_ms,
    announce_message_id,
    (extract(epoch from published_at) * 1000)::float8 as published_at_ms,
    (extract(epoch from voided_at) * 1000)::float8 as voided_at_ms,
    voided_by`;
}

function rewardColumns(sql: Query) {
  return sql`
    guild_id, user_id, achievement_id, tier_id, generation, reward_key, reward_epoch, kind,
    role_id, amount, status, attempts,
    (extract(epoch from lease_until) * 1000)::float8 as lease_until_ms,
    (extract(epoch from next_attempt_at) * 1000)::float8 as next_attempt_at_ms,
    transient, error_code, error,
    (extract(epoch from requested_at) * 1000)::float8 as requested_at_ms,
    (extract(epoch from delivered_at) * 1000)::float8 as delivered_at_ms,
    (extract(epoch from created_at) * 1000)::float8 as created_at_ms,
    (extract(epoch from updated_at) * 1000)::float8 as updated_at_ms`;
}

function toUnlock(row: UnlockDbRow): UnlockRow {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    achievementId: row.achievement_id,
    tierId: member(TIER_IDS, row.tier_id, 'Tier'),
    generation: row.generation,
    tierIndex: row.tier_index,
    unlockedAt: msOf(row.unlocked_at_ms, 'unlocked_at'),
    revision: row.revision,
    definition: unlockDefinitionSchema.parse(row.definition),
    progress: unlockProgressSchema.parse(row.progress),
    cause: unlockCauseSchema.parse(row.cause),
    originChannelId: row.origin_channel_id,
    announceGroup: row.announce_group,
    announceStatus: member(ANNOUNCE_STATUSES, row.announce_status, 'Announcement status'),
    announceAttempts: row.announce_attempts,
    announceLeaseUntil: ms(row.announce_lease_until_ms),
    announceError: row.announce_error,
    announcedAt: ms(row.announced_at_ms),
    announceMessageId: row.announce_message_id,
    publishedAt: ms(row.published_at_ms),
    voidedAt: ms(row.voided_at_ms),
    voidedBy: row.voided_by,
  };
}

function toReward(row: RewardDbRow): RewardRow {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    achievementId: row.achievement_id,
    tierId: member(TIER_IDS, row.tier_id, 'Tier'),
    generation: row.generation,
    rewardKey: row.reward_key,
    rewardEpoch: row.reward_epoch,
    kind: member(REWARD_KIND_IDS, row.kind, 'Reward kind'),
    roleId: row.role_id,
    amount: row.amount,
    status: member(REWARD_STATUSES, row.status, 'Reward status'),
    attempts: row.attempts,
    leaseUntil: ms(row.lease_until_ms),
    nextAttemptAt: ms(row.next_attempt_at_ms),
    transient: row.transient,
    errorCode: row.error_code,
    error: row.error,
    requestedAt: ms(row.requested_at_ms),
    deliveredAt: ms(row.delivered_at_ms),
    createdAt: msOf(row.created_at_ms, 'created_at'),
    updatedAt: msOf(row.updated_at_ms, 'updated_at'),
  };
}

function toState(
  row: StateDbRow & { achievement_id: string },
  userId: string,
): MemberAchievementState {
  const values: MemberAchievementState['values'] = {};
  const entries = Array.isArray(row.progress) ? row.progress : [];

  for (const entry of entries) {
    const parsed = progressEntrySchema.safeParse(entry);
    if (!parsed.success) continue;
    const [requirementId, value, version, generation] = parsed.data;
    values[requirementId] = { value, version, generation };
  }

  return {
    achievementId: row.achievement_id,
    userId,
    generation: row.generation,
    rewardEpoch: row.reward_epoch,
    countedFrom: ms(row.counted_from_ms),
    values,
    unlocked: tierIds(row.unlocked),
    almostNotified: tierIds(row.almost_notified),
    almostNotifiedAt: ms(row.almost_notified_at_ms),
  };
}

function toFacts(row: FactsDbRow): MemberFacts {
  return {
    userId: row.user_id,
    joinedAt: ms(row.joined_at_ms),
    premiumSince: ms(row.premium_since_ms),
    leftAt: ms(row.left_at_ms),
    updatedAt: msOf(row.updated_at_ms, 'updated_at'),
  };
}

function statesSelect(
  sql: Query,
  guildId: string,
  userId: string,
  achievementIds: readonly string[],
  source: ReturnType<typeof unlockColumns>,
) {
  return sql`
    select ids.achievement_id,
           coalesce(st.generation, 0) + coalesce(m.generation, 0) as generation,
           coalesce(st.reward_epoch, 0) + coalesce(m.reward_epoch, 0) as reward_epoch,
           (extract(epoch from greatest(st.counted_from, m.counted_from)) * 1000)::float8
             as counted_from_ms,
           to_jsonb(coalesce(m.almost_notified, array[]::text[])) as almost_notified,
           (extract(epoch from m.almost_notified_at) * 1000)::float8 as almost_notified_at_ms,
           coalesce((
             select jsonb_agg(jsonb_build_array(v.requirement_id, v.value, v.version, v.generation))
               from ${source} v
              where v.achievement_id = ids.achievement_id
           ), '[]'::jsonb) as progress,
           coalesce((
             select jsonb_agg(u.tier_id)
               from achievement_unlocks u
              where u.guild_id = ${guildId}
                and u.user_id = ${userId}
                and u.achievement_id = ids.achievement_id
                and u.voided_at is null
                and u.generation = coalesce(st.generation, 0) + coalesce(m.generation, 0)
           ), '[]'::jsonb) as unlocked
      from unnest(${[...achievementIds]}::text[]) as ids(achievement_id)
      left join achievement_state st
        on st.guild_id = ${guildId} and st.achievement_id = ids.achievement_id
      left join achievement_members m
        on m.guild_id = ${guildId} and m.achievement_id = ids.achievement_id and m.user_id = ${userId}`;
}

function orderedStates(
  rows: readonly StateDbRow[],
  userId: string,
  achievementIds: readonly string[],
): MemberAchievementState[] {
  const byId = new Map<string, MemberAchievementState>();

  for (const row of rows) {
    if (row.achievement_id === null) continue;
    byId.set(row.achievement_id, toState({ ...row, achievement_id: row.achievement_id }, userId));
  }

  return achievementIds.flatMap((id) => {
    const state = byId.get(id);
    return state ? [state] : [];
  });
}

function groupLock(guildId: string, groupKey: string): string {
  return `achievements:group:${guildId}:${groupKey}`;
}

function distinctTargets(targets: readonly ProgressTarget[]): ProgressTarget[] {
  const seen = new Map<string, ProgressTarget>();

  for (const target of targets) {
    if (!(target.amount > 0)) continue;
    const key = JSON.stringify([target.achievementId, target.requirementId]);
    if (!seen.has(key)) seen.set(key, target);
  }

  return [...seen.values()].sort(
    (a, b) => byText(a.achievementId, b.achievementId) || byText(a.requirementId, b.requirementId),
  );
}

async function insertAudit(sql: Query, entry: NewAuditTrailEntry, at: number): Promise<boolean> {
  const inserted = await sql`
    insert into audit_trail (id, guild_id, actor_id, source, action, before, after, ip_hash, created_at)
    values (${entry.id}, ${entry.guildId}, ${entry.actorId}, ${entry.source}, ${entry.action},
            ${jsonOrNull(entry.before)}::jsonb, ${jsonOrNull(entry.after)}::jsonb,
            ${entry.ipHash ?? null}, ${iso(entry.createdAt?.getTime() ?? at)}::timestamptz)
    on conflict (id) do nothing
    returning id`;

  return inserted.length > 0;
}

function toInterval(row: { started_ms: number; ended_ms: number | null }): Interval {
  return { start: msOf(row.started_ms, 'started_at'), end: ms(row.ended_ms) };
}

export class DrizzleAchievementStore implements AchievementStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #sql(): Client {
    return this.#handle.client;
  }

  async record(
    record: ActivityRecord,
    targets: readonly ProgressTarget[],
    achievementIds: readonly string[],
  ): Promise<RecordResult> {
    const groupKey = record.pending ? record.groupKey : null;
    if (groupKey === null) return this.#record(this.#sql, record, targets, achievementIds);

    // Read of the group marker and insert of the entry under one lock: without it an entry that
    // lands beside its giveaway's release is stored pending with nothing left to release it.
    return this.#sql.begin(async (sql) => {
      await sql`
        select pg_advisory_xact_lock(hashtextextended(${groupLock(record.guildId, groupKey)}, 0))`;
      return this.#record(sql, record, targets, achievementIds);
    });
  }

  async #record(
    sql: Query,
    record: ActivityRecord,
    targets: readonly ProgressTarget[],
    achievementIds: readonly string[],
  ): Promise<RecordResult> {
    const guildId = record.guildId;
    const userId = record.userId;
    const occurred = iso(record.occurredAt);
    const ids = [...new Set(achievementIds)];
    const targetsJson = JSON.stringify(
      distinctTargets(targets).map((target) => ({
        achievement_id: target.achievementId,
        requirement_id: target.requirementId,
        version: target.version,
        aggregate: target.aggregate,
        amount: Math.floor(target.amount),
      })),
    );

    const state =
      record.pending && record.groupKey !== null
        ? sql`coalesce((
              select g.state from achievement_seen g
               where g.guild_id = ${guildId} and g.metric = ${GROUP_RELEASE_METRIC}
                 and g.source_key = ${record.groupKey}
            ), 'pending')`
        : record.pending
          ? 'pending'
          : 'counted';

    // A day is deduplicated per target as well as globally: one consumed while no achievement
    // accepted it must still count for one that starts, resumes or is created later that day.
    const targetKey = () =>
      sql`c.achievement_id || ':' || c.requirement_id || ':' || c.generation::text || ':' ||
          ${record.sourceKey}::text`;
    const targetsCte =
      record.metric === 'active_days'
        ? sql`
      target_seen as (
        insert into achievement_seen (guild_id, metric, source_key, user_id, occurred_at, state)
        select ${guildId}::text, ${ACTIVE_DAY_TARGET_METRIC}::text, ${targetKey()},
               ${userId}::text, ${occurred}::timestamptz, 'counted'
          from candidates c
        on conflict (guild_id, metric, source_key) do nothing
        returning source_key
      ),
      targets as (
        select c.* from candidates c
         where exists (select 1 from target_seen t where t.source_key = ${targetKey()})
      )`
        : sql`
      targets as (
        select c.* from candidates c where exists (select 1 from counted)
      )`;

    const rows = await sql<(StateDbRow & { fresh: number })[]>`
      with seen as (
        insert into achievement_seen as s
          (guild_id, metric, source_key, user_id, occurred_at, state, group_key, channel_id,
           parent_id, category_id)
        values (${guildId}, ${record.metric}, ${record.sourceKey}, ${userId},
                ${occurred}::timestamptz, ${state},
                ${record.groupKey}, ${record.channelId}, ${record.parentId}, ${record.categoryId})
        on conflict (guild_id, metric, source_key) do update
           set state = excluded.state
         where s.state = 'pending' and excluded.state = 'counted'
        returning s.state
      ),
      counted as (
        select 1 from seen where state = 'counted'
      ),
      bucket as (
        insert into achievement_activity as a
          (guild_id, user_id, metric, hour, channel_key, channel_id, parent_id, category_id,
           temporary, xp_source, amount_sum, amount_max, span_start, events)
        select ${guildId}, ${userId}, ${record.metric},
               date_trunc('hour', ${occurred}::timestamptz, 'UTC'), ${record.channelId ?? ''},
               ${record.channelId}, ${record.parentId}, ${record.categoryId}, ${record.temporary},
               ${record.xpSource ?? ''}, ${record.amount}, ${record.amount},
               ${record.spanStart === null ? null : iso(record.spanStart)}::timestamptz, 1
          from counted
        on conflict (guild_id, user_id, metric, hour, channel_key, temporary, xp_source) do update
           set amount_sum = a.amount_sum + excluded.amount_sum,
               amount_max = greatest(a.amount_max, excluded.amount_max),
               span_start = case
                 when excluded.amount_max >= a.amount_max then excluded.span_start
                 else a.span_start
               end,
               events = a.events + 1,
               parent_id = excluded.parent_id,
               category_id = excluded.category_id
        returning 1
      ),
      candidates as (
        select t.achievement_id, t.requirement_id, t.version, t.aggregate, t.amount,
               coalesce(st.generation, 0) + coalesce(m.generation, 0) as generation
          from jsonb_to_recordset(${targetsJson}::jsonb)
               as t(achievement_id text, requirement_id text, version integer, aggregate text,
                    amount bigint)
          left join achievement_state st
            on st.guild_id = ${guildId} and st.achievement_id = t.achievement_id
          left join achievement_members m
            on m.guild_id = ${guildId} and m.achievement_id = t.achievement_id
           and m.user_id = ${userId}
         where coalesce(greatest(st.counted_from, m.counted_from) <= ${occurred}::timestamptz, true)
      ),
      ${targetsCte},
      summed as (
        insert into achievement_progress as p
          (guild_id, achievement_id, requirement_id, user_id, value, version, generation, updated_at)
        select ${guildId}, achievement_id, requirement_id, ${userId}, amount, version, generation,
               now()
          from targets
         where aggregate = 'sum'
         order by achievement_id, requirement_id
        on conflict (guild_id, achievement_id, requirement_id, user_id) do update
           set value = case
                 when (excluded.generation, excluded.version) > (p.generation, p.version)
                   then excluded.value
                 else p.value + excluded.value
               end,
               version = excluded.version,
               generation = excluded.generation,
               updated_at = excluded.updated_at
         where (excluded.generation, excluded.version) >= (p.generation, p.version)
        returning p.achievement_id, p.requirement_id, p.value, p.version, p.generation
      ),
      maxed as (
        insert into achievement_progress as p
          (guild_id, achievement_id, requirement_id, user_id, value, version, generation, updated_at)
        select ${guildId}, achievement_id, requirement_id, ${userId}, amount, version, generation,
               now()
          from targets
         where aggregate = 'max'
         order by achievement_id, requirement_id
        on conflict (guild_id, achievement_id, requirement_id, user_id) do update
           set value = case
                 when (excluded.generation, excluded.version) > (p.generation, p.version)
                   then excluded.value
                 else greatest(p.value, excluded.value)
               end,
               version = excluded.version,
               generation = excluded.generation,
               updated_at = excluded.updated_at
         where (excluded.generation, excluded.version) >= (p.generation, p.version)
        returning p.achievement_id, p.requirement_id, p.value, p.version, p.generation
      ),
      written as (
        select * from summed
        union all
        select * from maxed
      ),
      vals as (
        select achievement_id, requirement_id, value, version, generation from written
        union all
        select p.achievement_id, p.requirement_id, p.value, p.version, p.generation
          from achievement_progress p
         where p.guild_id = ${guildId}
           and p.user_id = ${userId}
           and p.achievement_id = any(${ids}::text[])
           and not exists (
             select 1 from written w
              where w.achievement_id = p.achievement_id and w.requirement_id = p.requirement_id
           )
      )
      select (select count(*) from seen)::int as fresh, states.*
        from (select 1) as one
        left join lateral (${statesSelect(sql, guildId, userId, ids, sql`vals`)}) as states on true`;

    return {
      fresh: (rows[0]?.fresh ?? 0) > 0,
      states: orderedStates(rows, userId, ids),
    };
  }

  async releasePending(
    guildId: string,
    groupKey: string,
    outcome: 'count' | 'void',
    origin: PendingOrigin,
  ): Promise<ActivityRecord[]> {
    return this.#sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${groupLock(guildId, groupKey)}, 0))`;
      return this.#release(sql, guildId, groupKey, outcome, origin);
    });
  }

  async #release(
    sql: Tx,
    guildId: string,
    groupKey: string,
    outcome: 'count' | 'void',
    origin: PendingOrigin,
  ): Promise<ActivityRecord[]> {
    // The marker carries no group_key: one that did would come back from the select below and be
    // read as a metric. The first outcome wins, so a cancel after a draw cannot un-count it.
    await sql`
      insert into achievement_seen (guild_id, metric, source_key, user_id, occurred_at, state)
      values (${guildId}, ${GROUP_RELEASE_METRIC}, ${groupKey}, ${MODULE_ROW}, now(),
              ${outcome === 'count' ? 'counted' : 'void'})
      on conflict (guild_id, metric, source_key) do nothing`;

    if (outcome === 'void') {
      await sql`
        update achievement_seen
           set state = 'void'
         where guild_id = ${guildId} and group_key = ${groupKey} and state = 'pending'`;
      return [];
    }

    const rows = await sql<
      {
        metric: string;
        source_key: string;
        user_id: string;
        occurred_at_ms: number;
        channel_id: string | null;
        parent_id: string | null;
        category_id: string | null;
      }[]
    >`
      select metric, source_key, user_id,
             (extract(epoch from occurred_at) * 1000)::float8 as occurred_at_ms,
             channel_id, parent_id, category_id
        from achievement_seen
       where guild_id = ${guildId} and group_key = ${groupKey} and state in ('pending', 'counted')
       order by occurred_at, user_id, source_key`;

    return rows.map((row) => ({
      guildId,
      userId: row.user_id,
      metric: member<LedgerMetric>(LEDGER_METRICS, row.metric, 'Metric'),
      sourceKey: row.source_key,
      occurredAt: msOf(row.occurred_at_ms, 'occurred_at'),
      spanStart: null,
      amount: 1,
      channelId: row.channel_id,
      parentId: row.parent_id,
      categoryId: row.category_id,
      temporary: false,
      xpSource: null,
      groupKey,
      pending: false,
      sourceModule: origin.sourceModule,
      causation: origin.causation,
    }));
  }

  async setValues(guildId: string, userId: string, values: readonly StateValue[]): Promise<void> {
    const distinct = new Map<string, StateValue>();
    for (const value of values) {
      distinct.set(JSON.stringify([value.achievementId, value.requirementId]), value);
    }
    if (distinct.size === 0) return;

    const json = JSON.stringify(
      [...distinct.values()].map((value) => ({
        achievement_id: value.achievementId,
        requirement_id: value.requirementId,
        version: value.version,
        value: Math.max(0, Math.floor(value.value)),
      })),
    );

    await this.#sql`
      insert into achievement_progress as p
        (guild_id, achievement_id, requirement_id, user_id, value, version, generation, updated_at)
      select ${guildId}, v.achievement_id, v.requirement_id, ${userId}, v.value, v.version,
             coalesce(st.generation, 0) + coalesce(m.generation, 0), now()
        from jsonb_to_recordset(${json}::jsonb)
             as v(achievement_id text, requirement_id text, version integer, value bigint)
        left join achievement_state st
          on st.guild_id = ${guildId} and st.achievement_id = v.achievement_id
        left join achievement_members m
          on m.guild_id = ${guildId} and m.achievement_id = v.achievement_id
         and m.user_id = ${userId}
      on conflict (guild_id, achievement_id, requirement_id, user_id) do update
         set value = excluded.value,
             version = excluded.version,
             generation = excluded.generation,
             updated_at = excluded.updated_at
       where (excluded.generation, excluded.version) >= (p.generation, p.version)`;
  }

  async memberStates(
    guildId: string,
    userId: string,
    achievementIds: readonly string[],
  ): Promise<MemberAchievementState[]> {
    const ids = [...new Set(achievementIds)];
    if (ids.length === 0) return [];

    const sql = this.#sql;
    const source = sql`(
      select achievement_id, requirement_id, value, version, generation
        from achievement_progress
       where guild_id = ${guildId} and user_id = ${userId}
    )`;
    const rows = await sql<StateDbRow[]>`${statesSelect(sql, guildId, userId, ids, source)}`;

    return orderedStates(rows, userId, ids);
  }

  async unlock(input: UnlockInput): Promise<UnlockResult> {
    const { guildId, userId, achievementId } = input;
    const tiers = [...new Map(input.tiers.map((tier) => [tier.tierId, tier])).values()];

    return this.#sql.begin(async (sql) => {
      await sql`
        insert into achievement_state (guild_id, achievement_id)
        values (${guildId}, ${achievementId})
        on conflict do nothing`;
      await sql`
        insert into achievement_members (guild_id, achievement_id, user_id)
        values (${guildId}, ${achievementId}, ${userId})
        on conflict do nothing`;

      const [held] = await sql<{ generation: number; reward_epoch: number }[]>`
        select st.generation + m.generation as generation,
               st.reward_epoch + m.reward_epoch as reward_epoch
          from achievement_state st
          join achievement_members m
            on m.guild_id = st.guild_id and m.achievement_id = st.achievement_id
         where st.guild_id = ${guildId}
           and st.achievement_id = ${achievementId}
           and m.user_id = ${userId}
           for share of st, m`;

      if (
        !held ||
        held.generation !== input.generation ||
        held.reward_epoch !== input.rewardEpoch
      ) {
        return { stale: true, unlocks: [], rewards: [] };
      }

      if (tiers.length === 0) return { stale: false, unlocks: [], rewards: [] };

      const unlockJson = JSON.stringify(
        tiers.map((tier) => ({
          tier_id: tier.tierId,
          tier_index: tier.tierIndex,
          revision: tier.revision,
          definition: tier.definition,
          progress: tier.progress,
        })),
      );

      const created = await sql<UnlockDbRow[]>`
        insert into achievement_unlocks
          (guild_id, user_id, achievement_id, tier_id, generation, tier_index, unlocked_at,
           revision, definition, progress, cause, origin_channel_id, announce_group,
           announce_status)
        select ${guildId}, ${userId}, ${achievementId}, t.tier_id, ${input.generation},
               t.tier_index, ${iso(input.unlockedAt)}::timestamptz, t.revision, t.definition,
               t.progress, ${JSON.stringify(input.cause)}::jsonb, ${input.originChannelId},
               ${input.announceGroup}, ${input.announce}
          from jsonb_to_recordset(${unlockJson}::jsonb)
               as t(tier_id text, tier_index integer, revision text, definition jsonb,
                    progress jsonb)
        on conflict do nothing
        returning ${unlockColumns(sql)}`;

      const unlocks = created.map(toUnlock);

      const rewardInputs = unlocks.flatMap((unlock) => {
        const tier = tiers.find((candidate) => candidate.tierId === unlock.tierId);
        const rewards = new Map(
          (tier?.definition.rewards ?? []).map((reward) => [rewardKeyOf(reward), reward]),
        );

        return [...rewards].map(([rewardKey, reward]) => ({
          tier_id: unlock.tierId,
          reward_key: rewardKey,
          kind: reward.kind,
          role_id: reward.kind === 'xp' ? null : reward.roleId,
          amount: reward.kind === 'xp' ? reward.amount : null,
        }));
      });

      if (rewardInputs.length === 0) return { stale: false, unlocks, rewards: [] };

      const at = iso(input.unlockedAt);
      const created_rewards = await sql<RewardDbRow[]>`
        insert into achievement_rewards
          (guild_id, user_id, achievement_id, tier_id, generation, reward_key, reward_epoch, kind,
           role_id, amount, status, error, created_at, updated_at)
        select ${guildId}, ${userId}, ${achievementId}, x.tier_id, ${input.generation},
               x.reward_key, ${input.rewardEpoch}, x.kind, x.role_id, x.amount,
               case when given.found then 'skipped' else 'pending' end,
               case when given.found then ${ALREADY_GIVEN} else null end,
               ${at}::timestamptz, ${at}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(rewardInputs)}::jsonb)
               as x(tier_id text, reward_key text, kind text, role_id text, amount integer)
          cross join lateral (
            select exists (
              select 1 from achievement_rewards e
               where e.guild_id = ${guildId}
                 and e.user_id = ${userId}
                 and e.achievement_id = ${achievementId}
                 and e.tier_id = x.tier_id
                 and e.reward_key = x.reward_key
                 and e.reward_epoch = ${input.rewardEpoch}
                 and e.generation < ${input.generation}
                 and e.status in ('delivered', 'delivering', 'requested')
            ) as found
          ) as given
        on conflict do nothing
        returning ${rewardColumns(sql)}`;

      return { stale: false, unlocks, rewards: created_rewards.map(toReward) };
    });
  }

  async publishable(guildId: string, limit: number): Promise<UnlockRow[]> {
    const sql = this.#sql;
    const rows = await sql<UnlockDbRow[]>`
      select ${unlockColumns(sql)}
        from achievement_unlocks
       where guild_id = ${guildId} and published_at is null and voided_at is null
       order by unlocked_at, user_id, achievement_id, tier_index
       limit ${Math.max(0, Math.floor(limit))}`;

    return rows.map(toUnlock);
  }

  async markPublished(rows: readonly UnlockRow[], now: number): Promise<void> {
    if (rows.length === 0) return;

    const keys = JSON.stringify(
      rows.map((row) => ({
        guild_id: row.guildId,
        user_id: row.userId,
        achievement_id: row.achievementId,
        tier_id: row.tierId,
        generation: row.generation,
      })),
    );

    await this.#sql`
      update achievement_unlocks u
         set published_at = coalesce(u.published_at, ${iso(now)}::timestamptz)
        from jsonb_to_recordset(${keys}::jsonb)
             as k(guild_id text, user_id text, achievement_id text, tier_id text,
                  generation integer)
       where u.guild_id = k.guild_id
         and u.user_id = k.user_id
         and u.achievement_id = k.achievement_id
         and u.tier_id = k.tier_id
         and u.generation = k.generation`;
  }

  async claimReward(
    ref: RewardRef,
    now: number,
    leaseMs: number,
    opts: { manual?: boolean } = {},
  ): Promise<RewardClaim | null> {
    const sql = this.#sql;
    const manual = opts.manual === true;
    const at = iso(now);

    const [row] = await sql<RewardDbRow[]>`
      update achievement_rewards
         set status = case when kind = 'xp' then 'requested' else 'delivering' end,
             attempts = attempts + 1,
             lease_until = case
               when kind = 'xp' then ${iso(now + XP_CONFIRM_TIMEOUT_MS)}::timestamptz
               else ${iso(now + leaseMs)}::timestamptz
             end,
             requested_at = case when kind = 'xp' then ${at}::timestamptz else requested_at end,
             next_attempt_at = null,
             transient = false,
             error_code = null,
             error = null,
             updated_at = ${at}::timestamptz
       where guild_id = ${ref.guildId}
         and user_id = ${ref.userId}
         and achievement_id = ${ref.achievementId}
         and tier_id = ${ref.tierId}
         and generation = ${ref.generation}
         and reward_key = ${ref.rewardKey}
         and (
           status = 'pending'
           or (status = 'failed' and transient
               and coalesce(next_attempt_at <= ${at}::timestamptz, true))
           or (status in ('delivering', 'requested')
               and coalesce(lease_until <= ${at}::timestamptz, true))
           or (${manual}::boolean and status = 'failed')
         )
         and (${manual}::boolean or attempts < ${MAX_REWARD_ATTEMPTS})
      returning ${rewardColumns(sql)}`;

    if (!row) return null;
    const reward = toReward(row);
    return { row: reward, token: reward.attempts };
  }

  async finishReward(ref: RewardRef, token: number, outcome: RewardOutcome): Promise<boolean> {
    const at = iso(outcome.now);
    const transient = outcome.status === 'failed' && outcome.transient === true;
    const next = outcome.nextAttemptAt ?? outcome.now;

    const finished = await this.#sql`
      update achievement_rewards
         set status = ${outcome.status},
             transient = ${transient}::boolean and attempts < ${MAX_REWARD_ATTEMPTS},
             next_attempt_at = case
               when ${transient}::boolean and attempts < ${MAX_REWARD_ATTEMPTS}
                 then ${iso(next)}::timestamptz
               else null
             end,
             error_code = ${outcome.errorCode ?? null},
             error = ${outcome.error ?? null},
             lease_until = null,
             delivered_at = case
               when ${outcome.status} = 'delivered' then ${at}::timestamptz
               else delivered_at
             end,
             updated_at = ${at}::timestamptz
       where guild_id = ${ref.guildId}
         and user_id = ${ref.userId}
         and achievement_id = ${ref.achievementId}
         and tier_id = ${ref.tierId}
         and generation = ${ref.generation}
         and reward_key = ${ref.rewardKey}
         and attempts = ${token}
         and status in ('delivering', 'requested')
      returning 1`;

    return finished.length > 0;
  }

  async confirmXpGrant(
    guildId: string,
    grantId: string,
    outcome: XpGrantOutcome,
  ): Promise<RewardRow | null> {
    const grant = parseXpGrantId(grantId);
    if (!grant || grant.guildId !== guildId) return null;

    return this.#sql.begin(async (sql) => {
      const [row] = await sql<RewardDbRow[]>`
        select ${rewardColumns(sql)}
          from achievement_rewards
         where guild_id = ${guildId}
           and user_id = ${grant.userId}
           and achievement_id = ${grant.achievementId}
           and tier_id = ${grant.tierId}
           and reward_key = 'xp'
           and reward_epoch = ${grant.rewardEpoch}
           and status in ('requested', 'delivering', 'failed', 'cancelled', 'delivered')
         order by generation desc
         limit 1
           for update`;

      if (!row) return null;
      const current = toReward(row);
      const at = iso(outcome.now);

      const settle = outcome.granted
        ? current.status !== 'delivered'
        : current.status === 'requested' ||
          current.status === 'delivering' ||
          current.status === 'failed';
      if (!settle) return current;

      const [updated] = await sql<RewardDbRow[]>`
        update achievement_rewards
           set status = ${outcome.granted ? 'delivered' : 'failed'},
               transient = false,
               next_attempt_at = null,
               lease_until = null,
               error_code = null,
               error = ${outcome.granted ? null : (outcome.error ?? XP_REFUSED)},
               delivered_at = ${outcome.granted ? at : null}::timestamptz,
               updated_at = ${at}::timestamptz
         where guild_id = ${guildId}
           and user_id = ${current.userId}
           and achievement_id = ${current.achievementId}
           and tier_id = ${current.tierId}
           and generation = ${current.generation}
           and reward_key = 'xp'
        returning ${rewardColumns(sql)}`;

      return updated ? toReward(updated) : current;
    });
  }

  async rewardsFor(
    guildId: string,
    userId: string,
    achievementId: string,
    generation: number,
  ): Promise<RewardRow[]> {
    const sql = this.#sql;
    const rows = await sql<RewardDbRow[]>`
      select ${rewardColumns(sql)}
        from achievement_rewards
       where guild_id = ${guildId}
         and user_id = ${userId}
         and achievement_id = ${achievementId}
         and generation = ${generation}
       order by array_position(${[...TIER_IDS]}::text[], tier_id), reward_key`;

    return rows.map(toReward);
  }

  async dueWork(guildId: string, now: number, limit: number): Promise<DueWork> {
    const sql = this.#sql;
    const at = iso(now);
    const take = Math.max(0, Math.floor(limit));

    const [rewards, rewardDue, groupRows, unpublished, unpublishedDue] = await Promise.all([
      sql<RewardDbRow[]>`
        select ${rewardColumns(sql)}
          from achievement_rewards
         where guild_id = ${guildId}
           and (
             status = 'pending'
             or (status = 'failed' and transient and attempts < ${MAX_REWARD_ATTEMPTS}
                 and coalesce(next_attempt_at <= ${at}::timestamptz, true))
             or (status in ('delivering', 'requested')
                 and coalesce(lease_until <= ${at}::timestamptz, true))
           )
         order by created_at, user_id, achievement_id, generation,
                  array_position(${[...TIER_IDS]}::text[], tier_id), reward_key
         limit ${take}`,
      sql<{ due_ms: number | null }[]>`
        select (extract(epoch from min(
                 case
                   when status = 'pending' then created_at
                   when status = 'failed' then coalesce(next_attempt_at, updated_at)
                   else coalesce(lease_until, updated_at)
                 end)) * 1000)::float8 as due_ms
          from achievement_rewards
         where guild_id = ${guildId}
           and (status in ('pending', 'delivering', 'requested')
                or (status = 'failed' and transient and attempts < ${MAX_REWARD_ATTEMPTS}))`,
      sql<
        {
          announce_group: string;
          user_id: string;
          achievement_id: string;
          generation: number;
          oldest_ms: number;
          attempts: number;
          settled: boolean;
          due_ms: number;
        }[]
      >`
        with pending as (
          select u.announce_group, u.user_id, u.achievement_id, u.generation, u.unlocked_at,
                 u.announce_attempts, u.announce_lease_until,
                 not exists (
                   select 1 from achievement_rewards r
                    where r.guild_id = u.guild_id
                      and r.user_id = u.user_id
                      and r.achievement_id = u.achievement_id
                      and r.tier_id = u.tier_id
                      and r.generation = u.generation
                      and (r.status in ('pending', 'delivering', 'requested')
                           or (r.status = 'failed' and r.transient))
                 ) as settled
            from achievement_unlocks u
           where u.guild_id = ${guildId}
             and u.announce_status = 'pending'
             and u.voided_at is null
        ),
        grouped as (
          select announce_group, min(user_id) as user_id, min(achievement_id) as achievement_id,
                 min(generation) as generation, min(unlocked_at) as oldest,
                 max(announce_attempts) as attempts, max(announce_lease_until) as lease,
                 bool_and(settled) as settled
            from pending
           group by announce_group
        )
        select announce_group, user_id, achievement_id, generation,
               (extract(epoch from oldest) * 1000)::float8 as oldest_ms, attempts, settled,
               (extract(epoch from greatest(
                  coalesce(lease, oldest),
                  case
                    when settled then oldest
                    else oldest + ${XP_CONFIRM_TIMEOUT_MS}::int * interval '1 millisecond'
                  end
               )) * 1000)::float8 as due_ms
          from grouped`,
      this.publishable(guildId, take),
      sql<{ due_ms: number | null }[]>`
        select (extract(epoch from min(unlocked_at)) * 1000)::float8 as due_ms
          from achievement_unlocks
         where guild_id = ${guildId} and published_at is null and voided_at is null`,
    ]);

    const groups = groupRows
      .map((row) => ({
        due: msOf(row.due_ms, 'due_at'),
        group: {
          group: row.announce_group,
          userId: row.user_id,
          achievementId: row.achievement_id,
          generation: row.generation,
          oldestUnlockedAt: msOf(row.oldest_ms, 'unlocked_at'),
          attempts: row.attempts,
          rewardsSettled: row.settled,
        } satisfies AnnounceGroup,
      }))
      .sort((a, b) => a.due - b.due || byText(a.group.group, b.group.group));

    const candidates = [
      ms(rewardDue[0]?.due_ms),
      ms(unpublishedDue[0]?.due_ms),
      groups[0]?.due ?? null,
    ].filter((due): due is number => due !== null);

    return {
      rewards: rewards.map(toReward),
      groups: groups
        .filter((entry) => entry.due <= now)
        .slice(0, take)
        .map((entry) => entry.group),
      unpublished,
      nextDueAt: candidates.length > 0 ? Math.min(...candidates) : null,
    };
  }

  async claimAnnouncement(
    guildId: string,
    group: string,
    now: number,
    leaseMs: number,
  ): Promise<AnnouncementClaim | null> {
    return this.#sql.begin(async (sql) => {
      const held = await sql<{ attempts: number; lease_ms: number | null }[]>`
        select announce_attempts as attempts,
               (extract(epoch from announce_lease_until) * 1000)::float8 as lease_ms
          from achievement_unlocks
         where guild_id = ${guildId}
           and announce_group = ${group}
           and announce_status = 'pending'
           and voided_at is null
           for update`;

      if (held.length === 0) return null;
      if (held.some((row) => row.lease_ms !== null && row.lease_ms > now)) return null;

      const attempt = Math.max(...held.map((row) => row.attempts)) + 1;

      const rows = await sql<UnlockDbRow[]>`
        update achievement_unlocks
           set announce_attempts = ${attempt},
               announce_lease_until = ${iso(now + leaseMs)}::timestamptz
         where guild_id = ${guildId}
           and announce_group = ${group}
           and announce_status = 'pending'
           and voided_at is null
        returning ${unlockColumns(sql)}`;

      const unlocks = rows
        .map(toUnlock)
        .sort((a, b) => a.tierIndex - b.tierIndex || byText(a.tierId, b.tierId));

      return { rows: unlocks, attempt };
    });
  }

  async finishAnnouncement(
    guildId: string,
    group: string,
    attempt: number,
    outcome: AnnouncementOutcome,
  ): Promise<void> {
    const at = iso(outcome.now);

    await this.#sql`
      update achievement_unlocks
         set announce_status = case
               when voided_at is not null and ${outcome.status} = 'pending' then 'skipped'
               else ${outcome.status}
             end,
             announce_error = ${outcome.error ?? null},
             announced_at = case
               when ${outcome.status} = 'sent' then ${at}::timestamptz
               else announced_at
             end,
             announce_message_id = coalesce(${outcome.messageId ?? null}, announce_message_id),
             announce_lease_until = null
       where guild_id = ${guildId}
         and announce_group = ${group}
         and announce_attempts = ${attempt}
         and announce_status in ('pending', 'skipped')`;
  }

  async claimAlmostThere(
    guildId: string,
    userId: string,
    achievementId: string,
    tierId: TierId,
    generation: number,
    now: number,
    cooldownMs: number,
  ): Promise<boolean> {
    return this.#sql.begin(async (sql) => {
      await sql`
        insert into achievement_members (guild_id, achievement_id, user_id)
        values (${guildId}, ${achievementId}, ${userId})
        on conflict do nothing`;

      // Locked in its own statement so the check below reads with a snapshot taken after any
      // unlock that held this row has committed.
      await sql`
        select 1 from achievement_members
         where guild_id = ${guildId} and achievement_id = ${achievementId} and user_id = ${userId}
           for update`;

      const claimed = await sql`
        update achievement_members m
           set almost_notified = array_append(m.almost_notified, ${tierId}::text),
               almost_notified_at = ${iso(now)}::timestamptz,
               updated_at = ${iso(now)}::timestamptz
         where m.guild_id = ${guildId}
           and m.achievement_id = ${achievementId}
           and m.user_id = ${userId}
           and not (${tierId}::text = any(m.almost_notified))
           and coalesce(m.almost_notified_at <= ${iso(now - cooldownMs)}::timestamptz, true)
           and m.generation + coalesce((
             select st.generation from achievement_state st
              where st.guild_id = m.guild_id and st.achievement_id = m.achievement_id
           ), 0) = ${generation}
           and not exists (
             select 1 from achievement_unlocks x
              where x.guild_id = m.guild_id
                and x.user_id = m.user_id
                and x.achievement_id = m.achievement_id
                and x.tier_id = ${tierId}
                and x.generation = ${generation}
                and x.voided_at is null
           )
        returning 1`;

      return claimed.length > 0;
    });
  }

  async syncPeriods(
    guildId: string,
    at: number,
    opts: { openOnly?: boolean } = {},
  ): Promise<{ firstActivation: string[]; reopened: string[] }> {
    return this.#sql.begin(async (sql) => {
      await sql`
        select pg_advisory_xact_lock(hashtextextended(${`achievements:periods:${guildId}`}, 0))`;

      const [row] = await sql<{ enabled: boolean; config: unknown }[]>`
        select enabled, config
          from guild_modules
         where guild_id = ${guildId} and module_id = ${MODULE_ID}`;

      const parsed = row ? achievementsConfigSchema.safeParse(row.config) : null;
      const config = parsed?.success ? parsed.data : null;
      const moduleOn = row?.enabled === true && config?.enabled === true;
      const active =
        moduleOn && config
          ? config.achievements.filter((achievement) => achievement.status === 'active')
          : [];
      const wanted = new Set(moduleOn ? [MODULE_ROW, ...active.map((a) => a.id)] : []);

      const periods = await sql<
        { achievement_id: string; started_ms: number; ended_ms: number | null }[]
      >`
        select achievement_id,
               (extract(epoch from started_at) * 1000)::float8 as started_ms,
               (extract(epoch from ended_at) * 1000)::float8 as ended_ms
          from achievement_periods
         where guild_id = ${guildId}`;

      const open = new Set<string>();
      const lastEnded = new Map<string, number>();

      for (const period of periods) {
        const ended = ms(period.ended_ms);
        if (ended === null) {
          open.add(period.achievement_id);
          continue;
        }

        const last = lastEnded.get(period.achievement_id) ?? ended;
        lastEnded.set(period.achievement_id, Math.max(last, ended));
      }

      const opening = [...wanted].filter((id) => !open.has(id));

      for (const id of opening) {
        const start = Math.max(at, lastEnded.get(id) ?? at);
        await sql`
          insert into achievement_periods (guild_id, achievement_id, started_at)
          values (${guildId}, ${id}, ${iso(start)}::timestamptz)
          on conflict (guild_id, achievement_id, started_at) do update set ended_at = null`;
      }

      if (!opts.openOnly) {
        const closing = [...open].filter((id) => !wanted.has(id));
        if (closing.length > 0) {
          await sql`
            update achievement_periods
               set ended_at = greatest(started_at, ${iso(at)}::timestamptz)
             where guild_id = ${guildId}
               and achievement_id = any(${closing}::text[])
               and ended_at is null`;
        }
      }

      if (opening.length === 0) return { firstActivation: [], reopened: [] };

      const activated = await sql<{ achievement_id: string }[]>`
        insert into achievement_state as st (guild_id, achievement_id, first_active_at, updated_at)
        select ${guildId}, id, ${iso(at)}::timestamptz, now()
          from unnest(${opening}::text[]) as ids(id)
        on conflict (guild_id, achievement_id) do update
           set first_active_at = excluded.first_active_at, updated_at = excluded.updated_at
         where st.first_active_at is null
        returning st.achievement_id`;

      const activatedIds = new Set(activated.map((entry) => entry.achievement_id));
      const firstActivation = [...activatedIds].filter((id) => id !== MODULE_ROW).sort();
      const reopened = opening.filter((id) => id !== MODULE_ROW && !activatedIds.has(id)).sort();

      const signatures: Record<string, string> = {};
      for (const achievement of active) {
        if (firstActivation.includes(achievement.id)) {
          signatures[achievement.id] = rebuildSignature(achievement);
        }
      }

      if (Object.keys(signatures).length > 0) {
        await mergeRebuilt(sql, guildId, signatures);
      }

      return { firstActivation, reopened };
    });
  }

  async runtime(guildId: string): Promise<GuildRuntime> {
    const sql = this.#sql;

    const [periods, states] = await Promise.all([
      sql<{ achievement_id: string; started_ms: number; ended_ms: number | null }[]>`
        select achievement_id,
               (extract(epoch from started_at) * 1000)::float8 as started_ms,
               (extract(epoch from ended_at) * 1000)::float8 as ended_ms
          from achievement_periods
         where guild_id = ${guildId}
         order by achievement_id, started_at`,
      sql<
        {
          achievement_id: string;
          generation: number;
          reward_epoch: number;
          counted_from_ms: number | null;
          first_active_at_ms: number | null;
          job_result: unknown;
        }[]
      >`
        select achievement_id, generation, reward_epoch,
               (extract(epoch from counted_from) * 1000)::float8 as counted_from_ms,
               (extract(epoch from first_active_at) * 1000)::float8 as first_active_at_ms,
               job_result
          from achievement_state
         where guild_id = ${guildId}`,
    ]);

    const modulePeriods: Interval[] = [];
    const byAchievement = new Map<string, Interval[]>();

    for (const period of periods) {
      const interval = toInterval(period);
      if (period.achievement_id === MODULE_ROW) modulePeriods.push(interval);
      else {
        const list = byAchievement.get(period.achievement_id) ?? [];
        list.push(interval);
        byAchievement.set(period.achievement_id, list);
      }
    }

    const bag = moduleBagSchema.safeParse(
      states.find((state) => state.achievement_id === MODULE_ROW)?.job_result ?? {},
    );
    const rebuilt = bag.success ? (bag.data.rebuilt ?? {}) : {};

    const state = new Map<string, AchievementRuntimeState>();
    for (const row of states) {
      if (row.achievement_id === MODULE_ROW) continue;
      state.set(row.achievement_id, {
        generation: row.generation,
        rewardEpoch: row.reward_epoch,
        countedFrom: ms(row.counted_from_ms),
        firstActiveAt: ms(row.first_active_at_ms),
        rebuiltWith: rebuilt[row.achievement_id] ?? null,
      });
    }

    return { modulePeriods, periods: byAchievement, state };
  }

  async upsertFacts(guildId: string, userId: string, facts: FactsPatch): Promise<void> {
    const changes: Partial<typeof achievementMemberFacts.$inferInsert> = {
      ...(facts.joinedAt !== undefined ? { joinedAt: dated(facts.joinedAt) } : {}),
      ...(facts.premiumSince !== undefined ? { premiumSince: dated(facts.premiumSince) } : {}),
      ...(facts.leftAt !== undefined ? { leftAt: dated(facts.leftAt) } : {}),
    };
    const set: PgUpdateSetSource<typeof achievementMemberFacts> = {
      ...changes,
      updatedAt: drizzleSql`now()`,
    };

    await this.#handle.db
      .insert(achievementMemberFacts)
      .values({ guildId, userId, ...changes })
      .onConflictDoUpdate({
        target: [achievementMemberFacts.guildId, achievementMemberFacts.userId],
        set,
      });
  }

  async facts(guildId: string, userId: string): Promise<MemberFacts | null> {
    const [row] = await this.#sql<FactsDbRow[]>`
      select user_id,
             (extract(epoch from joined_at) * 1000)::float8 as joined_at_ms,
             (extract(epoch from premium_since) * 1000)::float8 as premium_since_ms,
             (extract(epoch from left_at) * 1000)::float8 as left_at_ms,
             (extract(epoch from updated_at) * 1000)::float8 as updated_at_ms
        from achievement_member_facts
       where guild_id = ${guildId} and user_id = ${userId}`;

    return row ? toFacts(row) : null;
  }

  async anniversaryCandidates(
    guildId: string,
    windows: readonly AnniversaryWindow[],
    afterUserId: string | null,
    limit: number,
  ): Promise<MemberFacts[]> {
    if (windows.length === 0) return [];

    const json = JSON.stringify(
      windows.map((window) => ({ from_ms: window.from, to_ms: window.to })),
    );

    const rows = await this.#sql<FactsDbRow[]>`
      select user_id,
             (extract(epoch from joined_at) * 1000)::float8 as joined_at_ms,
             (extract(epoch from premium_since) * 1000)::float8 as premium_since_ms,
             (extract(epoch from left_at) * 1000)::float8 as left_at_ms,
             (extract(epoch from updated_at) * 1000)::float8 as updated_at_ms
        from achievement_member_facts f
       where f.guild_id = ${guildId}
         and f.left_at is null
         and f.joined_at is not null
         and (${afterUserId}::text is null or f.user_id > ${afterUserId}::text)
         and exists (
           select 1 from jsonb_to_recordset(${json}::jsonb) as w(from_ms float8, to_ms float8)
            where extract(epoch from f.joined_at) * 1000 > w.from_ms
              and extract(epoch from f.joined_at) * 1000 <= w.to_ms
         )
       order by f.user_id
       limit ${Math.max(0, Math.floor(limit))}`;

    return rows.map(toFacts);
  }

  async anniversaryRunAt(guildId: string): Promise<number | null> {
    const [row] = await this.#sql<{ job_result: unknown }[]>`
      select job_result from achievement_state
       where guild_id = ${guildId} and achievement_id = ${MODULE_ROW}`;

    const bag = moduleBagSchema.safeParse(row?.job_result ?? {});
    return bag.success ? (bag.data.anniversaryRunAt ?? null) : null;
  }

  async setAnniversaryRunAt(guildId: string, at: number): Promise<void> {
    const patch = JSON.stringify({ anniversaryRunAt: at });

    await this.#sql`
      insert into achievement_state as st (guild_id, achievement_id, job_result)
      values (${guildId}, ${MODULE_ROW}, ${patch}::jsonb)
      on conflict (guild_id, achievement_id) do update
         set job_result = coalesce(st.job_result, '{}'::jsonb) || excluded.job_result,
             updated_at = now()`;
  }

  async putBadge(guildId: string, asset: BadgeAsset): Promise<void> {
    const uploadedAt = new Date(asset.uploadedAt);

    await this.#handle.db
      .insert(achievementBadges)
      .values({
        guildId,
        assetId: asset.assetId,
        contentType: asset.contentType,
        base64: asset.base64,
        byteSize: asset.byteSize,
        uploadedBy: asset.uploadedBy,
        uploadedAt,
      })
      .onConflictDoUpdate({
        target: [achievementBadges.guildId, achievementBadges.assetId],
        set: { uploadedBy: asset.uploadedBy, uploadedAt },
      });
  }

  async badge(
    guildId: string,
    assetId: string,
  ): Promise<{ contentType: string; base64: string } | null> {
    const [row] = await this.#handle.db
      .select({ contentType: achievementBadges.contentType, base64: achievementBadges.base64 })
      .from(achievementBadges)
      .where(and(eq(achievementBadges.guildId, guildId), eq(achievementBadges.assetId, assetId)))
      .limit(1);

    return row ?? null;
  }

  async pruneBadges(guildId: string, keep: readonly string[], olderThan: number): Promise<number> {
    const pruned = await this.#handle.db
      .delete(achievementBadges)
      .where(
        and(
          eq(achievementBadges.guildId, guildId),
          notInArray(achievementBadges.assetId, [...keep]),
          lt(achievementBadges.uploadedAt, new Date(olderThan)),
        ),
      )
      .returning({ assetId: achievementBadges.assetId });

    return pruned.length;
  }

  async rebuildSlice(
    guildId: string,
    plan: RebuildPlan,
    cursor: string | null,
    mode: RebuildMode,
  ): Promise<RebuildSliceResult> {
    const empty: RebuildSliceResult = {
      cursor: null,
      members: 0,
      changed: 0,
      lost: 0,
      newlyEarned: { ...NO_NEWLY_EARNED },
    };
    if (plan.requirements.length === 0) return empty;

    const remember = { [plan.achievementId]: plan.signature };

    const run = async (sql: Tx): Promise<RebuildSliceResult> => {
      const userIds = await rebuildMembers(sql, guildId, plan, cursor);
      if (userIds.length === 0) {
        if (mode === 'write') await mergeRebuilt(sql, guildId, remember);
        return empty;
      }

      if (mode === 'write') await lockRebuildRows(sql, guildId, plan, userIds);

      const members = await rebuildRead(sql, guildId, plan, userIds);
      const outcome = outcomeOf(plan, members);

      if (mode === 'write' && outcome.writes.length > 0) {
        const writes = JSON.stringify(
          outcome.writes.map((write) => ({
            user_id: write.userId,
            requirement_id: write.requirementId,
            value: write.value,
            version: write.version,
            generation: write.generation,
          })),
        );

        await sql`
          update achievement_progress p
             set value = w.value, version = w.version, generation = w.generation, updated_at = now()
            from jsonb_to_recordset(${writes}::jsonb)
                 as w(user_id text, requirement_id text, value bigint, version integer,
                      generation integer)
           where p.guild_id = ${guildId}
             and p.achievement_id = ${plan.achievementId}
             and p.user_id = w.user_id
             and p.requirement_id = w.requirement_id`;
      }

      const next = userIds.length < JOB_SLICE ? null : (userIds[userIds.length - 1] ?? null);
      if (mode === 'write' && next === null) await mergeRebuilt(sql, guildId, remember);

      return {
        cursor: next,
        members: userIds.length,
        changed: outcome.changed,
        lost: outcome.lost,
        newlyEarned: outcome.newlyEarned,
      };
    };

    return mode === 'write'
      ? this.#sql.begin(run)
      : this.#sql.begin('isolation level repeatable read read only', run);
  }

  async membersForRecheck(
    guildId: string,
    achievementId: string,
    cursor: string | null,
    limit: number,
    opts: { unlockedIn?: readonly string[] | 'any' } = {},
  ): Promise<{ userIds: string[]; cursor: string | null }> {
    const take = Math.max(1, Math.floor(limit));
    const unlockedIn = opts.unlockedIn;
    const anyUnlock = unlockedIn === 'any';
    const unlockIds = Array.isArray(unlockedIn) ? [...unlockedIn] : [];
    const useUnlocks = anyUnlock || unlockIds.length > 0;

    const rows = await this.#sql<{ user_id: string }[]>`
      select user_id from (
        (select distinct user_id from achievement_progress
          where guild_id = ${guildId}
            and achievement_id = ${achievementId}
            and (${cursor}::text is null or user_id > ${cursor}::text)
          order by user_id
          limit ${take})
        union
        (select distinct user_id from achievement_unlocks
          where ${useUnlocks}::boolean
            and guild_id = ${guildId}
            and voided_at is null
            and (${anyUnlock}::boolean or achievement_id = any(${unlockIds}::text[]))
            and (${cursor}::text is null or user_id > ${cursor}::text)
          order by user_id
          limit ${take})
      ) candidates
      order by user_id
      limit ${take}`;

    const userIds = rows.map((row) => row.user_id);
    return {
      userIds,
      cursor: userIds.length < take ? null : (userIds[userIds.length - 1] ?? null),
    };
  }

  async setJob(guildId: string, achievementId: string, patch: JobPatch): Promise<void> {
    const changes: Partial<typeof achievementState.$inferInsert> = {
      ...(patch.job !== undefined ? { job: patch.job } : {}),
      ...(patch.status !== undefined ? { jobStatus: patch.status } : {}),
      ...(patch.cursor !== undefined ? { jobCursor: patch.cursor } : {}),
      ...(patch.requestedAt !== undefined ? { jobRequestedAt: dated(patch.requestedAt) } : {}),
      ...(patch.requestedBy !== undefined ? { jobRequestedBy: patch.requestedBy } : {}),
      ...(patch.finishedAt !== undefined ? { jobFinishedAt: dated(patch.finishedAt) } : {}),
      ...(patch.result !== undefined ? { jobResult: patch.result } : {}),
      ...(patch.announce !== undefined ? { jobAnnounce: patch.announce } : {}),
      ...(patch.acceptLoss !== undefined ? { jobAcceptLoss: patch.acceptLoss } : {}),
    };
    const set: PgUpdateSetSource<typeof achievementState> = {
      ...changes,
      updatedAt: drizzleSql`now()`,
    };

    await this.#handle.db
      .insert(achievementState)
      .values({ guildId, achievementId, ...changes })
      .onConflictDoUpdate({
        target: [achievementState.guildId, achievementState.achievementId],
        set,
      });
  }

  async job(guildId: string, achievementId: string): Promise<JobState | null> {
    const rows = await this.#jobRows(guildId, achievementId);
    return rows[0] ?? null;
  }

  async jobs(guildId: string): Promise<JobState[]> {
    return (await this.#jobRows(guildId, null)).filter((state) => state.job !== null);
  }

  async #jobRows(guildId: string, achievementId: string | null): Promise<JobState[]> {
    const rows = await this.#handle.db
      .select()
      .from(achievementState)
      .where(
        achievementId === null
          ? eq(achievementState.guildId, guildId)
          : and(
              eq(achievementState.guildId, guildId),
              eq(achievementState.achievementId, achievementId),
            ),
      );

    return rows
      .filter((row) => row.achievementId !== MODULE_ROW)
      .sort((a, b) => byText(a.achievementId, b.achievementId))
      .map((row) => {
        const result = jobResultSchema.safeParse(row.jobResult);
        return {
          achievementId: row.achievementId,
          job: row.job === null ? null : member(ACHIEVEMENT_JOBS, row.job, 'Job'),
          status: row.jobStatus === null ? null : member(JOB_STATUSES, row.jobStatus, 'Job status'),
          cursor: row.jobCursor,
          requestedAt: row.jobRequestedAt?.getTime() ?? null,
          requestedBy: row.jobRequestedBy,
          finishedAt: row.jobFinishedAt?.getTime() ?? null,
          result: result.success ? result.data : null,
          announce: row.jobAnnounce,
          acceptLoss: row.jobAcceptLoss,
        };
      });
  }

  async resetMember(input: ResetMemberInput): Promise<{ achievements: number }> {
    const ids = [...new Set(input.achievementIds)];
    const at = iso(input.at);

    return this.#sql.begin(async (sql) => {
      if (!(await insertAudit(sql, input.audit, input.at))) return { achievements: 0 };
      if (ids.length === 0) return { achievements: 0 };

      await sql`
        insert into achievement_members (guild_id, achievement_id, user_id)
        select ${input.guildId}, id, ${input.userId} from unnest(${ids}::text[]) as ids(id)
        on conflict do nothing`;

      await sql`
        select 1 from achievement_state
         where guild_id = ${input.guildId} and achievement_id = any(${ids}::text[])
           for share`;

      await sql`
        update achievement_members
           set generation = generation + 1,
               reward_epoch = reward_epoch + ${input.allowRewardsAgain ? 1 : 0},
               counted_from = ${at}::timestamptz,
               reset_at = ${at}::timestamptz,
               reset_by = ${input.actorId},
               almost_notified = array[]::text[],
               almost_notified_at = null,
               updated_at = ${at}::timestamptz
         where guild_id = ${input.guildId}
           and user_id = ${input.userId}
           and achievement_id = any(${ids}::text[])`;

      await voidUnlocks(sql, {
        guildId: input.guildId,
        achievementIds: ids,
        userId: input.userId,
        actorId: input.actorId,
        at,
      });

      return { achievements: ids.length };
    });
  }

  async resetAchievement(input: ResetAchievementInput): Promise<{ members: number }> {
    const at = iso(input.at);
    const { guildId, achievementId } = input;

    return this.#sql.begin(async (sql) => {
      if (!(await insertAudit(sql, input.audit, input.at))) return { members: 0 };

      await sql`
        insert into achievement_state (guild_id, achievement_id)
        values (${guildId}, ${achievementId})
        on conflict do nothing`;

      const [bumped] = await sql<{ generation: number }[]>`
        update achievement_state
           set generation = generation + 1,
               reward_epoch = reward_epoch + ${input.allowRewardsAgain ? 1 : 0},
               counted_from = ${at}::timestamptz,
               reset_at = ${at}::timestamptz,
               reset_by = ${input.actorId},
               updated_at = ${at}::timestamptz
         where guild_id = ${guildId} and achievement_id = ${achievementId}
        returning generation - 1 as generation`;
      const before = bumped?.generation ?? 0;

      const [affected] = await sql<{ members: number }[]>`
        select count(*)::int as members from (
          select u.user_id from achievement_unlocks u
           where u.guild_id = ${guildId} and u.achievement_id = ${achievementId}
             and u.voided_at is null
          union
          select p.user_id from achievement_progress p
            left join achievement_members m
              on m.guild_id = p.guild_id and m.achievement_id = p.achievement_id
             and m.user_id = p.user_id
           where p.guild_id = ${guildId} and p.achievement_id = ${achievementId}
             and p.value > 0
             and p.generation = ${before} + coalesce(m.generation, 0)
        ) touched`;

      await sql`
        update achievement_members
           set almost_notified = array[]::text[], almost_notified_at = null,
               updated_at = ${at}::timestamptz
         where guild_id = ${guildId}
           and achievement_id = ${achievementId}
           and (cardinality(almost_notified) > 0 or almost_notified_at is not null)`;

      await voidUnlocks(sql, {
        guildId,
        achievementIds: [achievementId],
        userId: null,
        actorId: input.actorId,
        at,
      });

      return { members: affected?.members ?? 0 };
    });
  }

  async unlocksOf(guildId: string, userId: string): Promise<UnlockRow[]> {
    const sql = this.#sql;
    const rows = await sql<UnlockDbRow[]>`
      select ${unlockColumns(sql)}
        from achievement_unlocks x
       where ${currentUnlock(sql, guildId, userId)}
       order by unlocked_at, achievement_id, tier_index`;

    return rows.map(toUnlock);
  }

  async earnedCount(
    guildId: string,
    userId: string,
    excludeIds: readonly string[],
  ): Promise<number> {
    const sql = this.#sql;
    const [row] = await sql<{ earned: number }[]>`
      select count(distinct achievement_id)::int as earned
        from achievement_unlocks x
       where ${currentUnlock(sql, guildId, userId)}
         and not (achievement_id = any(${[...excludeIds]}::text[]))`;

    return row?.earned ?? 0;
  }

  async topBadges(guildId: string, userId: string, limit: number): Promise<UnlockRow[]> {
    const sql = this.#sql;
    const rows = await sql<(UnlockDbRow & { tier_rank: number })[]>`
      select * from (
        select distinct on (achievement_id) ${unlockColumns(sql)},
               array_position(${[...TIER_IDS]}::text[], tier_id) as tier_rank
          from achievement_unlocks x
         where ${currentUnlock(sql, guildId, userId)}
         order by achievement_id, tier_rank desc, unlocked_at desc
      ) best
      order by tier_rank desc, unlocked_at_ms desc, achievement_id
      limit ${Math.max(0, Math.floor(limit))}`;

    return rows.map(toUnlock);
  }

  async holders(guildId: string): Promise<TierHolders[]> {
    const rows = await this.#sql<{ achievement_id: string; tier_id: string; members: number }[]>`
      select achievement_id, tier_id, count(distinct user_id)::int as members
        from achievement_unlocks
       where guild_id = ${guildId} and voided_at is null
       group by achievement_id, tier_id
       order by achievement_id, array_position(${[...TIER_IDS]}::text[], tier_id)`;

    return rows.map((row) => ({
      achievementId: row.achievement_id,
      tierId: member(TIER_IDS, row.tier_id, 'Tier'),
      members: row.members,
    }));
  }

  async inProgress(guildId: string): Promise<AchievementMembersCount[]> {
    const rows = await this.#sql<{ achievement_id: string; members: number }[]>`
      select p.achievement_id, count(distinct p.user_id)::int as members
        from achievement_progress p
        left join achievement_state st
          on st.guild_id = p.guild_id and st.achievement_id = p.achievement_id
        left join achievement_members m
          on m.guild_id = p.guild_id and m.achievement_id = p.achievement_id
         and m.user_id = p.user_id
       where p.guild_id = ${guildId}
         and p.value > 0
         and p.generation = coalesce(st.generation, 0) + coalesce(m.generation, 0)
       group by p.achievement_id
       order by p.achievement_id`;

    return rows.map((row) => ({ achievementId: row.achievement_id, members: row.members }));
  }

  async rewardCounts(guildId: string): Promise<RewardStatusCount[]> {
    const rows = await this.#sql<{ achievement_id: string; status: string; count: number }[]>`
      select achievement_id, status, count(*)::int as count
        from achievement_rewards
       where guild_id = ${guildId}
       group by achievement_id, status
       order by achievement_id, status`;

    return rows.map((row) => ({
      achievementId: row.achievement_id,
      status: member(REWARD_STATUSES, row.status, 'Reward status'),
      count: row.count,
    }));
  }

  async listUnlocks(guildId: string, query: UnlockListQuery): Promise<Page<UnlockRow>> {
    const sql = this.#sql;
    const achievementId = query.achievementId ?? null;
    const offset = (query.page - 1) * query.pageSize;

    const [[counted], rows] = await Promise.all([
      sql<{ total: number }[]>`
        select count(*)::int as total
          from achievement_unlocks
         where guild_id = ${guildId}
           and voided_at is null
           and (${achievementId}::text is null or achievement_id = ${achievementId}::text)`,
      sql<UnlockDbRow[]>`
        select ${unlockColumns(sql)}
          from achievement_unlocks
         where guild_id = ${guildId}
           and voided_at is null
           and (${achievementId}::text is null or achievement_id = ${achievementId}::text)
         order by unlocked_at desc, user_id, achievement_id, tier_index
         limit ${query.pageSize} offset ${offset}`,
    ]);

    return { items: rows.map(toUnlock), total: counted?.total ?? 0 };
  }

  async listRewards(guildId: string, query: RewardListQuery): Promise<Page<RewardRow>> {
    const sql = this.#sql;
    const achievementId = query.achievementId ?? null;
    const statuses =
      query.status === 'failed'
        ? ['failed']
        : query.status === 'pending'
          ? ['pending', 'delivering', 'requested']
          : [...REWARD_STATUSES];
    const offset = (query.page - 1) * query.pageSize;

    const [[counted], rows] = await Promise.all([
      sql<{ total: number }[]>`
        select count(*)::int as total
          from achievement_rewards
         where guild_id = ${guildId}
           and status = any(${statuses}::text[])
           and (${achievementId}::text is null or achievement_id = ${achievementId}::text)`,
      sql<RewardDbRow[]>`
        select ${rewardColumns(sql)}
          from achievement_rewards
         where guild_id = ${guildId}
           and status = any(${statuses}::text[])
           and (${achievementId}::text is null or achievement_id = ${achievementId}::text)
         order by updated_at desc, user_id, achievement_id, tier_id, reward_key
         limit ${query.pageSize} offset ${offset}`,
    ]);

    return { items: rows.map(toReward), total: counted?.total ?? 0 };
  }

  async memberDetail(guildId: string, userId: string): Promise<MemberDetailRows> {
    const sql = this.#sql;

    const [unlockRows, rewardRows, idRows, facts] = await Promise.all([
      sql<UnlockDbRow[]>`
        select ${unlockColumns(sql)}
          from achievement_unlocks
         where guild_id = ${guildId} and user_id = ${userId}
         order by unlocked_at, achievement_id, tier_index`,
      sql<RewardDbRow[]>`
        select ${rewardColumns(sql)}
          from achievement_rewards
         where guild_id = ${guildId} and user_id = ${userId}
         order by created_at, achievement_id, generation,
                  array_position(${[...TIER_IDS]}::text[], tier_id), reward_key`,
      sql<{ achievement_id: string }[]>`
        select achievement_id from achievement_progress
         where guild_id = ${guildId} and user_id = ${userId}
        union
        select achievement_id from achievement_members
         where guild_id = ${guildId} and user_id = ${userId}
        union
        select achievement_id from achievement_unlocks
         where guild_id = ${guildId} and user_id = ${userId}
        order by achievement_id`,
      this.facts(guildId, userId),
    ]);

    const unlocks = unlockRows.map(toUnlock);

    return {
      states: await this.memberStates(
        guildId,
        userId,
        idRows.map((row) => row.achievement_id),
      ),
      unlocks: unlocks.filter((unlock) => unlock.voidedAt === null),
      voided: unlocks.filter((unlock) => unlock.voidedAt !== null),
      rewards: rewardRows.map(toReward),
      facts,
    };
  }

  async purge(now: number): Promise<PurgeResult> {
    const sql = this.#sql;
    const retention = JSON.stringify(
      Object.entries({ ...SEEN_RETENTION_MS, ...RESERVED_SEEN_RETENTION_MS }).flatMap(
        ([metric, keep]) => (keep === null ? [] : [{ metric, cutoff_ms: now - keep }]),
      ),
    );

    const activity = await sql`
      delete from achievement_activity
       where hour < ${iso(now - ACTIVITY_RETENTION_DAYS * DAY_MS)}::timestamptz`;

    const seen = await sql`
      delete from achievement_seen s
       using jsonb_to_recordset(${retention}::jsonb) as r(metric text, cutoff_ms float8)
       where s.metric = r.metric
         and s.state <> 'pending'
         and extract(epoch from s.seen_at) * 1000 < r.cutoff_ms`;

    // A current member's join date never ages out: anniversaries read this row years after it
    // was last written, and nothing refreshes it while they lurk.
    const facts = await sql`
      delete from achievement_member_facts
       where (left_at is not null and left_at < ${iso(now - FACTS_AFTER_LEAVING_MS)}::timestamptz)
          or (joined_at is null and left_at is null
              and updated_at < ${iso(now - ACTIVITY_RETENTION_DAYS * DAY_MS)}::timestamptz)`;

    return { activity: activity.count, seen: seen.count, facts: facts.count };
  }
}

function currentUnlock(sql: Query, guildId: string, userId: string) {
  return sql`
    x.guild_id = ${guildId}
    and x.user_id = ${userId}
    and x.voided_at is null
    and x.generation = coalesce((
      select st.generation from achievement_state st
       where st.guild_id = x.guild_id and st.achievement_id = x.achievement_id
    ), 0) + coalesce((
      select m.generation from achievement_members m
       where m.guild_id = x.guild_id and m.achievement_id = x.achievement_id
         and m.user_id = x.user_id
    ), 0)`;
}

async function voidUnlocks(
  sql: Tx,
  input: {
    guildId: string;
    achievementIds: readonly string[];
    userId: string | null;
    actorId: string;
    at: string;
  },
): Promise<void> {
  const ids = [...input.achievementIds];

  await sql`
    update achievement_unlocks
       set voided_at = ${input.at}::timestamptz,
           voided_by = ${input.actorId},
           announce_status = case
             when announce_status = 'pending' then 'skipped'
             else announce_status
           end,
           announce_error = case
             when announce_status = 'pending' then ${RESET_BEFORE_ANNOUNCED}
             else announce_error
           end
     where guild_id = ${input.guildId}
       and achievement_id = any(${ids}::text[])
       and (${input.userId}::text is null or user_id = ${input.userId}::text)
       and voided_at is null`;

  await sql`
    update achievement_rewards
       set status = 'cancelled',
           transient = false,
           next_attempt_at = null,
           lease_until = null,
           error = ${CANCELLED_BY_RESET},
           updated_at = ${input.at}::timestamptz
     where guild_id = ${input.guildId}
       and achievement_id = any(${ids}::text[])
       and (${input.userId}::text is null or user_id = ${input.userId}::text)
       and status in ('pending', 'failed')`;
}

async function mergeRebuilt(
  sql: Tx,
  guildId: string,
  signatures: Record<string, string>,
): Promise<void> {
  const patch = JSON.stringify(signatures);

  await sql`
    insert into achievement_state as st (guild_id, achievement_id, job_result)
    values (${guildId}, ${MODULE_ROW}, jsonb_build_object('rebuilt', ${patch}::jsonb))
    on conflict (guild_id, achievement_id) do update
       set job_result = coalesce(st.job_result, '{}'::jsonb) || jsonb_build_object(
             'rebuilt',
             coalesce(st.job_result -> 'rebuilt', '{}'::jsonb) || ${patch}::jsonb
           ),
           updated_at = now()`;
}

async function rebuildMembers(
  sql: Tx,
  guildId: string,
  plan: RebuildPlan,
  cursor: string | null,
): Promise<string[]> {
  const metrics = [...new Set(plan.requirements.map((requirement) => requirement.metric))];
  const earliest = plan.windows.length > 0 ? Math.min(...plan.windows.map((w) => w.start)) : null;

  const rows = await sql<{ user_id: string }[]>`
    select user_id from (
      (select distinct user_id from achievement_activity
        where ${earliest !== null}::boolean
          and guild_id = ${guildId}
          and metric = any(${metrics}::text[])
          and hour >= ${iso(earliest ?? 0)}::timestamptz
          and (${cursor}::text is null or user_id > ${cursor}::text)
        order by user_id
        limit ${JOB_SLICE})
      union
      (select distinct user_id from achievement_progress
        where guild_id = ${guildId}
          and achievement_id = ${plan.achievementId}
          and (${cursor}::text is null or user_id > ${cursor}::text)
        order by user_id
        limit ${JOB_SLICE})
    ) candidates
    order by user_id
    limit ${JOB_SLICE}`;

  return rows.map((row) => row.user_id);
}

async function lockRebuildRows(
  sql: Tx,
  guildId: string,
  plan: RebuildPlan,
  userIds: readonly string[],
): Promise<void> {
  const users = [...userIds];
  const requirements = JSON.stringify(
    plan.requirements.map((requirement) => ({
      requirement_id: requirement.requirementId,
      version: requirement.version,
    })),
  );

  await sql`
    insert into achievement_state (guild_id, achievement_id)
    values (${guildId}, ${plan.achievementId})
    on conflict do nothing`;

  await sql`
    select 1 from achievement_state
     where guild_id = ${guildId} and achievement_id = ${plan.achievementId}
       for share`;

  await sql`
    select 1 from achievement_members
     where guild_id = ${guildId}
       and achievement_id = ${plan.achievementId}
       and user_id = any(${users}::text[])
       for share`;

  await sql`
    insert into achievement_progress
      (guild_id, achievement_id, requirement_id, user_id, value, version, generation)
    select ${guildId}, ${plan.achievementId}, r.requirement_id, u.user_id, 0, r.version,
           coalesce(st.generation, 0) + coalesce(m.generation, 0)
      from unnest(${users}::text[]) as u(user_id)
      cross join jsonb_to_recordset(${requirements}::jsonb)
           as r(requirement_id text, version integer)
      left join achievement_state st
        on st.guild_id = ${guildId} and st.achievement_id = ${plan.achievementId}
      left join achievement_members m
        on m.guild_id = ${guildId} and m.achievement_id = ${plan.achievementId}
       and m.user_id = u.user_id
    on conflict do nothing`;

  // A record committed before this lock is visible to the aggregate read that follows; one that
  // commits after it adds on top of the rebuilt value, so neither is lost.
  await sql`
    select 1 from achievement_progress
     where guild_id = ${guildId}
       and achievement_id = ${plan.achievementId}
       and user_id = any(${users}::text[])
     order by user_id, requirement_id
       for update`;
}

interface RebuildMemberRow {
  user_id: string;
  generation: number;
  rebuilt: unknown;
  current: unknown;
  unlocked: unknown;
}

async function rebuildRead(
  sql: Tx,
  guildId: string,
  plan: RebuildPlan,
  userIds: readonly string[],
): Promise<RebuildMemberRow[]> {
  return sql<RebuildMemberRow[]>`
    with bounds as (
      select u.user_id,
             coalesce(st.generation, 0) + coalesce(m.generation, 0) as generation,
             greatest(st.counted_from, m.counted_from) as counted_from
        from unnest(${[...userIds]}::text[]) as u(user_id)
        left join achievement_state st
          on st.guild_id = ${guildId} and st.achievement_id = ${plan.achievementId}
        left join achievement_members m
          on m.guild_id = ${guildId} and m.achievement_id = ${plan.achievementId}
         and m.user_id = u.user_id
    ),
    reqs as (
      select * from jsonb_to_recordset(${rebuildRequirementsJson(plan)}::jsonb)
        as r(requirement_id text, version integer, metric text, aggregate text,
             temporary_only boolean, xp_sources text[], channel_ids text[],
             excluded_channel_ids text[])
    ),
    wins as (
      select to_timestamp(w.start_ms / 1000.0) as start_at,
             to_timestamp(w.end_ms / 1000.0) as end_at
        from jsonb_to_recordset(${rebuildWindowsJson(plan.windows)}::jsonb)
             as w(start_ms float8, end_ms float8)
    ),
    rebuilt as (
      select b.user_id, r.requirement_id,
             case
               when r.aggregate = 'max' then coalesce(max(
                 case
                   when x.span_start is null or win.start_at is null
                        or win.start_at <= x.span_start then x.amount_max
                   else greatest(
                     x.amount_max
                       - floor(extract(epoch from (win.start_at - x.span_start)) / 60), 0)
                 end), 0)::float8
               else coalesce(sum(x.amount_sum), 0)::float8
             end as value
        from bounds b
        cross join reqs r
        left join achievement_activity x
          on x.guild_id = ${guildId}
         and x.user_id = b.user_id
         and x.metric = r.metric
         and (b.counted_from is null
              or x.hour >= date_trunc(
                'hour', b.counted_from + interval '1 hour' - interval '1 millisecond', 'UTC'))
         and exists (
           select 1 from wins w
            where x.hour >= w.start_at and (w.end_at is null or x.hour < w.end_at)
         )
         and (not r.temporary_only or x.temporary)
         and (r.xp_sources is null or x.xp_source = any(r.xp_sources))
         and not (array[x.channel_id, x.parent_id, x.category_id] && r.excluded_channel_ids)
         and (cardinality(r.channel_ids) = 0
              or array[x.channel_id, x.parent_id, x.category_id] && r.channel_ids)
        left join lateral (
          select max(w.start_at) as start_at from wins w
           where x.hour >= w.start_at and (w.end_at is null or x.hour < w.end_at)
        ) win on true
       group by b.user_id, r.requirement_id, r.aggregate
    )
    select b.user_id, b.generation,
           coalesce((
             select jsonb_agg(jsonb_build_array(rb.requirement_id, rb.value))
               from rebuilt rb where rb.user_id = b.user_id
           ), '[]'::jsonb) as rebuilt,
           coalesce((
             select jsonb_agg(jsonb_build_array(p.requirement_id, p.value::float8, p.version,
                                                p.generation))
               from achievement_progress p
              where p.guild_id = ${guildId}
                and p.achievement_id = ${plan.achievementId}
                and p.user_id = b.user_id
           ), '[]'::jsonb) as current,
           coalesce((
             select jsonb_agg(u.tier_id)
               from achievement_unlocks u
              where u.guild_id = ${guildId}
                and u.user_id = b.user_id
                and u.achievement_id = ${plan.achievementId}
                and u.voided_at is null
                and u.generation = b.generation
           ), '[]'::jsonb) as unlocked
      from bounds b
     order by b.user_id`;
}

const rebuiltEntrySchema = z.tuple([z.string(), z.number()]);

function outcomeOf(plan: RebuildPlan, rows: readonly RebuildMemberRow[]): RebuildOutcome {
  return rebuildOutcome(
    plan,
    rows.map((row): RebuildMemberInput => {
      const rebuilt: Record<string, number> = {};
      for (const entry of Array.isArray(row.rebuilt) ? row.rebuilt : []) {
        const parsed = rebuiltEntrySchema.safeParse(entry);
        if (parsed.success) rebuilt[parsed.data[0]] = Math.round(parsed.data[1]);
      }

      const current: Record<string, { value: number; version: number; generation: number }> = {};
      for (const entry of Array.isArray(row.current) ? row.current : []) {
        const parsed = progressEntrySchema.safeParse(entry);
        if (!parsed.success) continue;
        const [requirementId, value, version, generation] = parsed.data;
        current[requirementId] = { value: Math.round(value), version, generation };
      }

      return {
        userId: row.user_id,
        generation: row.generation,
        rebuilt,
        current,
        unlocked: tierIds(row.unlocked),
      };
    }),
  );
}
