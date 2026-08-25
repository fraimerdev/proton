import { newId } from '@proton/core';
import type { DbHandle } from '@proton/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { newShortCode, parseShortCode } from './short-code.ts';
import type {
  BlacklistEntry,
  BlacklistSubject,
  BonusGrant,
  CreateGiveawayInput,
  Disqualification,
  DrawRecord,
  DropOutcome,
  EnterOutcome,
  EntrantRow,
  Giveaway,
  GiveawayEvent,
  GiveawayEventKind,
  GiveawayPatch,
  GiveawayStats,
  GiveawayStatus,
  GiveawayStore,
  ListGiveawaysQuery,
  MemberSnapshot,
  MultiplierRow,
  NewBonus,
  NewEntry,
  NewGiveawayEvent,
  RecordDrawInput,
  RequirementRow,
  Reweigh,
  TemplateRecord,
  WinRecord,
} from './store.ts';
import { GIVEAWAY_STATUSES } from './store.ts';
import {
  type GiveawayBonusRow,
  type GiveawayRow,
  giveawayBlacklist,
  giveawayBonusEntries,
  giveawayDraws,
  giveawayEntries,
  giveawayEvents,
  giveawayMultipliers,
  giveawayRequirements,
  giveaways,
  giveawayTemplates,
  giveawayWins,
} from './table.ts';

function toGiveaway(row: GiveawayRow): Giveaway {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    hostId: row.hostId,
    title: row.title,
    description: row.description,
    bannerUrl: row.bannerUrl,
    color: row.color,
    emoji: row.emoji,
    buttonStyle: row.buttonStyle,
    winnerCount: row.winnerCount,
    requirementLogic: row.requirementLogic === 'any' ? 'any' : 'all',
    requirementTree: row.requirementTree,
    maxEntriesPerUser: row.maxEntriesPerUser,
    verifyOn: row.verifyOn === 'join' ? 'join' : row.verifyOn === 'draw' ? 'draw' : 'both',
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    endedAt: row.endedAt,
    status: row.status as GiveawayStatus,
    drawingStartedAt: row.drawingStartedAt,
    shortCode: row.shortCode,
    entryMethod:
      row.entryMethod === 'reaction' ? 'reaction' : row.entryMethod === 'drop' ? 'drop' : 'button',
    pausedAt: row.pausedAt,
    pausedBy: row.pausedBy,
    pauseReason: row.pauseReason,
    pausedMs: Number(row.pausedMs ?? 0),
    claimWindowSeconds: row.claimWindowSeconds,
    dmWinners: row.dmWinners,
    winMessage: row.winMessage,
    prizes: row.prizes,
    rewardRoleId: row.rewardRoleId,
    templateId: row.templateId,
    recurrence: row.recurrence,
    recurrenceConfig: row.recurrenceConfig,
    recurrenceLeft: row.recurrenceLeft,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBonus(row: GiveawayBonusRow): BonusGrant {
  return {
    id: row.id,
    giveawayId: row.giveawayId,
    userId: row.userId,
    amount: row.amount,
    reason: row.reason,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

function toSnapshot(raw: unknown): MemberSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;

  return {
    roleIds: Array.isArray(value.roleIds)
      ? value.roleIds.filter((id): id is string => typeof id === 'string')
      : null,
    joinedAt: typeof value.joinedAt === 'string' ? value.joinedAt : null,
    premiumSince: typeof value.premiumSince === 'string' ? value.premiumSince : null,
    hasAvatar: typeof value.hasAvatar === 'boolean' ? value.hasAvatar : null,
  };
}

export class DrizzleGiveawayStore implements GiveawayStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async create(input: CreateGiveawayInput): Promise<Giveaway> {
    return this.#handle.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(giveaways)
        .values({
          id: input.id,
          guildId: input.guildId,
          channelId: input.channelId,
          messageId: input.messageId,
          hostId: input.hostId,
          title: input.title,
          description: input.description ?? null,
          bannerUrl: input.bannerUrl ?? null,
          color: input.color ?? null,
          emoji: input.emoji ?? null,
          buttonStyle: input.buttonStyle ?? 1,
          winnerCount: input.winnerCount,
          requirementLogic: input.requirementLogic ?? 'all',
          requirementTree: input.requirementTree ?? null,
          maxEntriesPerUser: input.maxEntriesPerUser ?? null,
          verifyOn: input.verifyOn ?? 'both',
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt,
          status: input.status ?? 'running',
          shortCode: input.shortCode ?? newShortCode(),
          entryMethod: input.entryMethod ?? 'button',
          claimWindowSeconds: input.claimWindowSeconds ?? null,
          dmWinners: input.dmWinners ?? false,
          winMessage: input.winMessage ?? null,
          prizes: input.prizes ?? null,
          rewardRoleId: input.rewardRoleId ?? null,
          templateId: input.templateId ?? null,
          recurrence: input.recurrence ?? null,
          recurrenceConfig: input.recurrenceConfig ?? null,
          recurrenceLeft: input.recurrenceLeft ?? null,
          createdBy: input.createdBy,
        })
        .returning();

      if (!row) throw new Error('giveaway insert returned no row');

      if (input.requirements?.length) {
        await tx.insert(giveawayRequirements).values(
          input.requirements.map((requirement, index) => ({
            id: newId(),
            giveawayId: input.id,
            providerId: requirement.providerId,
            config: requirement.config,
            position: requirement.position ?? index,
          })),
        );
      }

      if (input.multipliers?.length) {
        await tx.insert(giveawayMultipliers).values(
          input.multipliers.map((multiplier, index) => ({
            id: newId(),
            giveawayId: input.id,
            providerId: multiplier.providerId,
            config: multiplier.config,
            mode: multiplier.mode,
            position: multiplier.position ?? index,
          })),
        );
      }

      return toGiveaway(row);
    });
  }

  async get(guildId: string, giveawayId: string): Promise<Giveaway | null> {
    const [row] = await this.#handle.db
      .select()
      .from(giveaways)
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, giveawayId)))
      .limit(1);

    return row ? toGiveaway(row) : null;
  }

  async byMessage(guildId: string, messageId: string): Promise<Giveaway | null> {
    const [row] = await this.#handle.db
      .select()
      .from(giveaways)
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.messageId, messageId)))
      .limit(1);

    return row ? toGiveaway(row) : null;
  }

  async list(query: ListGiveawaysQuery): Promise<Giveaway[]> {
    const filters = [eq(giveaways.guildId, query.guildId)];

    // 'running' stays strict for the entitlement count; 'live' is what a host means by "show me
    // my giveaways", and a paused one vanishing from that list is how it gets forgotten.
    if (query.state === 'running') filters.push(eq(giveaways.status, 'running'));
    if (query.state === 'live') {
      filters.push(inArray(giveaways.status, ['scheduled', 'running', 'paused', 'drawing']));
    }
    if (query.state === 'ended') filters.push(inArray(giveaways.status, ['ended', 'cancelled']));
    if (query.prefix) {
      // Escaped: an unescaped % typed into autocomplete matches every giveaway in the guild, and
      // an _ matches any single character, so the suggestions stop reflecting what was typed.
      const prefix = query.prefix.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`);
      filters.push(sql`lower(${giveaways.title}) like ${`${prefix}%`} escape '\\'`);
    }

    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(and(...filters))
      .orderBy(desc(giveaways.createdAt))
      .limit(query.limit);

    return rows.map(toGiveaway);
  }

  async countRunning(guildId: string): Promise<number> {
    const [row] = await this.#handle.db
      .select({ value: count() })
      .from(giveaways)
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.status, 'running')));

    return row?.value ?? 0;
  }

  async setMessageId(giveawayId: string, messageId: string): Promise<void> {
    await this.#handle.db
      .update(giveaways)
      .set({ messageId, updatedAt: new Date() })
      .where(eq(giveaways.id, giveawayId));
  }

  async clearMessage(guildId: string, giveawayId: string): Promise<boolean> {
    const rows = await this.#handle.db
      .update(giveaways)
      .set({ messageId: null, updatedAt: new Date() })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          isNotNull(giveaways.messageId),
        ),
      )
      .returning({ id: giveaways.id });

    return rows.length > 0;
  }

  async byChannel(guildId: string, channelId: string): Promise<Giveaway[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.channelId, channelId)))
      .orderBy(desc(giveaways.createdAt));

    return rows.map(toGiveaway);
  }

  async requirements(giveawayId: string): Promise<RequirementRow[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayRequirements)
      .where(eq(giveawayRequirements.giveawayId, giveawayId))
      .orderBy(asc(giveawayRequirements.position));

    return rows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      config: row.config,
      position: row.position,
    }));
  }

  async multipliers(giveawayId: string): Promise<MultiplierRow[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayMultipliers)
      .where(eq(giveawayMultipliers.giveawayId, giveawayId))
      .orderBy(asc(giveawayMultipliers.position));

    return rows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      config: row.config,
      position: row.position,
      mode: row.mode === 'multiply' ? 'multiply' : row.mode === 'max' ? 'max' : 'add',
    }));
  }

  // The status predicate is inside the insert, not only in the caller: a press that arrives in the
  // window between the caller's read and this write must not enter a giveaway that has since been
  // paused, cancelled or drawn.
  async enter(entry: NewEntry): Promise<EnterOutcome> {
    const inserted = await this.#handle.db.execute(sql`
      insert into ${giveawayEntries} (
        giveaway_id, user_id, base_entries, total_entries, breakdown, member_snapshot
      )
      select ${entry.giveawayId}, ${entry.userId}, ${entry.baseEntries}, ${entry.totalEntries},
             ${JSON.stringify(entry.breakdown)}::jsonb,
             ${entry.memberSnapshot === null ? null : JSON.stringify(entry.memberSnapshot)}::jsonb
      where exists (
        select 1 from ${giveaways}
         where ${giveaways.id} = ${entry.giveawayId} and ${giveaways.status} = 'running'
      )
      on conflict do nothing
      returning user_id
    `);

    if (inserted.length > 0) return 'entered';

    // Zero rows is ambiguous — already entered, or no longer running. One extra read, only ever
    // on the path that is about to refuse the member anyway.
    const existing = await this.entry(entry.giveawayId, entry.userId);
    return existing ? 'already-entered' : 'closed';
  }

  async entry(giveawayId: string, userId: string): Promise<EntrantRow | null> {
    const [row] = await this.#handle.db
      .select()
      .from(giveawayEntries)
      .where(and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.userId, userId)))
      .limit(1);

    if (!row) return null;

    return {
      userId: row.userId,
      totalEntries: row.totalEntries,
      memberSnapshot: toSnapshot(row.memberSnapshot),
    };
  }

  async entrantCount(giveawayId: string): Promise<number> {
    const [row] = await this.#handle.db
      .select({ value: count() })
      .from(giveawayEntries)
      .where(
        and(
          eq(giveawayEntries.giveawayId, giveawayId),
          isNull(giveawayEntries.disqualifiedAt),
          isNull(giveawayEntries.leftAt),
        ),
      );

    return row?.value ?? 0;
  }

  async entrantCounts(giveawayIds: readonly string[]): Promise<Map<string, number>> {
    if (giveawayIds.length === 0) return new Map();

    const rows = await this.#handle.db
      .select({ giveawayId: giveawayEntries.giveawayId, value: count() })
      .from(giveawayEntries)
      .where(
        and(
          inArray(giveawayEntries.giveawayId, [...giveawayIds]),
          isNull(giveawayEntries.disqualifiedAt),
          isNull(giveawayEntries.leftAt),
        ),
      )
      .groupBy(giveawayEntries.giveawayId);

    return new Map(rows.map((row) => [row.giveawayId, row.value]));
  }

  // Keyset paging on user_id ascending. Offset paging would re-read rows as earlier ones are
  // disqualified mid-walk, and the ascending order is what the draw's reproducibility rests on.
  async *entrants(giveawayId: string, chunkSize: number): AsyncIterable<EntrantRow[]> {
    let after: string | null = null;

    for (;;) {
      const filters = [
        eq(giveawayEntries.giveawayId, giveawayId),
        isNull(giveawayEntries.disqualifiedAt),
        isNull(giveawayEntries.leftAt),
      ];
      if (after !== null) filters.push(gt(giveawayEntries.userId, after));

      const rows = await this.#handle.db
        .select()
        .from(giveawayEntries)
        .where(and(...filters))
        .orderBy(asc(giveawayEntries.userId))
        .limit(chunkSize);

      if (rows.length === 0) return;

      yield rows.map((row) => ({
        userId: row.userId,
        totalEntries: row.totalEntries,
        memberSnapshot: toSnapshot(row.memberSnapshot),
      }));

      if (rows.length < chunkSize) return;
      after = rows[rows.length - 1]?.userId ?? null;
      if (after === null) return;
    }
  }

  async topEntrants(giveawayId: string, limit: number): Promise<EntrantRow[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayEntries)
      .where(
        and(
          eq(giveawayEntries.giveawayId, giveawayId),
          isNull(giveawayEntries.disqualifiedAt),
          isNull(giveawayEntries.leftAt),
        ),
      )
      .orderBy(desc(giveawayEntries.totalEntries), asc(giveawayEntries.userId))
      .limit(limit);

    return rows.map((row) => ({
      userId: row.userId,
      totalEntries: row.totalEntries,
      memberSnapshot: toSnapshot(row.memberSnapshot),
    }));
  }

  // Four aggregates rather than one join: joining entries and wins against giveaways in a single
  // statement multiplies the rows and double-counts every entry by the number of draws.
  async stats(guildId: string): Promise<GiveawayStats> {
    const scoped = eq(giveaways.guildId, guildId);

    const [statuses, entries, winners, draws] = await Promise.all([
      this.#handle.db
        .select({ status: giveaways.status, value: count() })
        .from(giveaways)
        .where(scoped)
        .groupBy(giveaways.status),

      this.#handle.db
        .select({
          entries: sql<number>`coalesce(sum(${giveawayEntries.totalEntries}), 0)`,
          entrants: sql<number>`count(distinct ${giveawayEntries.userId})`,
        })
        .from(giveawayEntries)
        .innerJoin(giveaways, eq(giveaways.id, giveawayEntries.giveawayId))
        .where(and(scoped, isNull(giveawayEntries.disqualifiedAt), isNull(giveawayEntries.leftAt))),

      this.#handle.db
        .select({ value: count() })
        .from(giveawayWins)
        .innerJoin(giveaways, eq(giveaways.id, giveawayWins.giveawayId))
        .where(scoped),

      this.#handle.db
        .select({ value: count() })
        .from(giveawayDraws)
        .innerJoin(giveaways, eq(giveaways.id, giveawayDraws.giveawayId))
        .where(scoped),
    ]);

    const byStatus = Object.fromEntries(GIVEAWAY_STATUSES.map((status) => [status, 0])) as Record<
      GiveawayStatus,
      number
    >;

    let totalGiveaways = 0;
    for (const row of statuses) {
      if ((GIVEAWAY_STATUSES as readonly string[]).includes(row.status)) {
        byStatus[row.status as GiveawayStatus] = row.value;
      }
      totalGiveaways += row.value;
    }

    return {
      byStatus,
      totalGiveaways,
      totalEntries: Number(entries[0]?.entries ?? 0),
      uniqueEntrants: Number(entries[0]?.entrants ?? 0),
      totalWinners: winners[0]?.value ?? 0,
      draws: draws[0]?.value ?? 0,
    };
  }

  async appendEvent(event: NewGiveawayEvent): Promise<boolean> {
    const rows = await this.#handle.db
      .insert(giveawayEvents)
      .values({
        id: event.id,
        guildId: event.guildId,
        giveawayId: event.giveawayId,
        kind: event.kind,
        actorId: event.actorId,
        detail: event.detail ?? null,
        idempotencyKey: event.idempotencyKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: giveawayEvents.id });

    return rows.length > 0;
  }

  async history(giveawayId: string, limit: number): Promise<GiveawayEvent[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayEvents)
      .where(eq(giveawayEvents.giveawayId, giveawayId))
      .orderBy(asc(giveawayEvents.at))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      guildId: row.guildId,
      giveawayId: row.giveawayId,
      kind: row.kind as GiveawayEventKind,
      actorId: row.actorId,
      detail: row.detail,
      idempotencyKey: row.idempotencyKey,
      at: row.at,
    }));
  }

  async disqualify(
    giveawayId: string,
    rows: readonly Disqualification[],
    at: Date,
  ): Promise<number> {
    if (rows.length === 0) return 0;

    let updated = 0;
    await this.#handle.db.transaction(async (tx) => {
      for (const row of rows) {
        const result = await tx
          .update(giveawayEntries)
          .set({ disqualifiedAt: at, disqualifyReason: row.reason, revalidatedAt: at })
          .where(
            and(
              eq(giveawayEntries.giveawayId, giveawayId),
              eq(giveawayEntries.userId, row.userId),
              isNull(giveawayEntries.disqualifiedAt),
            ),
          )
          .returning({ userId: giveawayEntries.userId });

        updated += result.length;
      }
    });

    return updated;
  }

  /**
   * One statement for the whole chunk, not one per entrant — a 500-row chunk was 500 sequential
   * round trips inside an open transaction. The bonus sum is added here rather than by the caller
   * so a grant made mid-giveaway survives the draw-time recompute.
   */
  async reweigh(giveawayId: string, rows: readonly Reweigh[], at: Date): Promise<number> {
    if (rows.length === 0) return 0;

    const values = sql.join(
      rows.map(
        (row) =>
          sql`(${row.userId}::text, ${row.totalEntries}::integer, ${JSON.stringify(row.breakdown)}::jsonb)`,
      ),
      sql`, `,
    );

    const updated = await this.#handle.db.execute(sql`
      update ${giveawayEntries} e
         set total_entries = greatest(1, v.total + coalesce((
               select sum(b.amount) from ${giveawayBonusEntries} b
                where b.giveaway_id = e.giveaway_id
                  and b.user_id = e.user_id
                  and b.revoked_at is null
             ), 0)),
             breakdown = v.breakdown,
             revalidated_at = ${at}
        from (values ${values}) as v(user_id, total, breakdown)
       where e.giveaway_id = ${giveawayId} and e.user_id = v.user_id
      returning e.user_id
    `);

    return updated.length;
  }

  async grantBonus(input: NewBonus): Promise<BonusGrant> {
    return this.#handle.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(giveawayBonusEntries)
        .values({
          id: input.id,
          giveawayId: input.giveawayId,
          userId: input.userId,
          amount: input.amount,
          reason: input.reason,
          grantedBy: input.grantedBy,
        })
        .returning();

      if (!row) throw new Error('bonus insert returned no row');

      // total_entries is the cache the draw reads, so it moves with the grant. A member who has
      // not entered yet has no row to move; their bonus lands when they join.
      await tx
        .update(giveawayEntries)
        .set({ totalEntries: sql`${giveawayEntries.totalEntries} + ${input.amount}` })
        .where(
          and(
            eq(giveawayEntries.giveawayId, input.giveawayId),
            eq(giveawayEntries.userId, input.userId),
          ),
        );

      return toBonus(row);
    });
  }

  async revokeBonus(giveawayId: string, userId: string, by: string, at: Date): Promise<number> {
    return this.#handle.db.transaction(async (tx) => {
      const revoked = await tx
        .update(giveawayBonusEntries)
        .set({ revokedAt: at, revokedBy: by })
        .where(
          and(
            eq(giveawayBonusEntries.giveawayId, giveawayId),
            eq(giveawayBonusEntries.userId, userId),
            isNull(giveawayBonusEntries.revokedAt),
          ),
        )
        .returning({ amount: giveawayBonusEntries.amount });

      const total = revoked.reduce((sum, row) => sum + row.amount, 0);
      if (total === 0) return 0;

      await tx
        .update(giveawayEntries)
        .set({ totalEntries: sql`greatest(1, ${giveawayEntries.totalEntries} - ${total})` })
        .where(and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.userId, userId)));

      return total;
    });
  }

  async bonusFor(giveawayId: string, userId: string): Promise<number> {
    const [row] = await this.#handle.db
      .select({ total: sql<number>`coalesce(sum(${giveawayBonusEntries.amount}), 0)` })
      .from(giveawayBonusEntries)
      .where(
        and(
          eq(giveawayBonusEntries.giveawayId, giveawayId),
          eq(giveawayBonusEntries.userId, userId),
          isNull(giveawayBonusEntries.revokedAt),
        ),
      );

    return Number(row?.total ?? 0);
  }

  async bonusGrants(giveawayId: string, userId?: string): Promise<BonusGrant[]> {
    const filters = [eq(giveawayBonusEntries.giveawayId, giveawayId)];
    if (userId !== undefined) filters.push(eq(giveawayBonusEntries.userId, userId));

    const rows = await this.#handle.db
      .select()
      .from(giveawayBonusEntries)
      .where(and(...filters))
      .orderBy(desc(giveawayBonusEntries.grantedAt));

    return rows.map(toBonus);
  }

  async beginDraw(guildId: string, giveawayId: string, at: Date): Promise<Giveaway | null> {
    const [row] = await this.#handle.db
      .update(giveaways)
      .set({ status: 'drawing', drawingStartedAt: at, updatedAt: at })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          eq(giveaways.status, 'running'),
        ),
      )
      .returning();

    return row ? toGiveaway(row) : null;
  }

  async recordDraw(input: RecordDrawInput): Promise<{ drawId: string } | 'already-drawn'> {
    return this.#handle.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(giveawayDraws)
        .values({
          id: input.id,
          giveawayId: input.giveawayId,
          drawNumber: input.drawNumber,
          seed: input.seed,
          snapshotHash: input.snapshotHash,
          entrantCount: input.entrantCount,
          totalEntries: input.totalEntries,
          winnerIds: [...input.winnerIds],
          degradedProviders: [...input.degradedProviders],
          drawnBy: input.drawnBy,
          reason: input.reason ?? null,
        })
        .onConflictDoNothing({
          target: [giveawayDraws.giveawayId, giveawayDraws.drawNumber],
        })
        .returning({ id: giveawayDraws.id });

      if (!row) return 'already-drawn' as const;

      if (input.winnerIds.length > 0) {
        await tx.insert(giveawayWins).values(
          input.winnerIds.map((userId) => ({
            giveawayId: input.giveawayId,
            drawId: row.id,
            userId,
            claimDeadline: input.claimDeadline ?? null,
          })),
        );
      }

      return { drawId: row.id };
    });
  }

  async finishDraw(
    guildId: string,
    giveawayId: string,
    from: readonly GiveawayStatus[],
    to: GiveawayStatus,
    endedAt: Date | null,
  ): Promise<boolean> {
    if (from.length === 0) return false;

    const rows = await this.#handle.db
      .update(giveaways)
      .set({ status: to, endedAt, drawingStartedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          inArray(giveaways.status, from as string[]),
        ),
      )
      .returning({ id: giveaways.id });

    return rows.length > 0;
  }

  async pause(
    guildId: string,
    giveawayId: string,
    by: string,
    reason: string | null,
    at: Date,
  ): Promise<Giveaway | null> {
    const [row] = await this.#handle.db
      .update(giveaways)
      .set({ status: 'paused', pausedAt: at, pausedBy: by, pauseReason: reason, updatedAt: at })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          eq(giveaways.status, 'running'),
        ),
      )
      .returning();

    return row ? toGiveaway(row) : null;
  }

  // ends_at moves by now - paused_at, computed in SQL from the stored instant rather than from
  // anything the caller measured: a resume issued by a worker with a skewed clock must not shorten
  // or lengthen the giveaway.
  async resume(guildId: string, giveawayId: string, at: Date): Promise<Giveaway | null> {
    const [row] = await this.#handle.db
      .update(giveaways)
      .set({
        status: 'running',
        endsAt: sql`${giveaways.endsAt} + (${at} - ${giveaways.pausedAt})`,
        pausedMs: sql`${giveaways.pausedMs} + (extract(epoch from (${at} - ${giveaways.pausedAt})) * 1000)::bigint`,
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          eq(giveaways.status, 'paused'),
          sql`${giveaways.pausedAt} is not null`,
        ),
      )
      .returning();

    return row ? toGiveaway(row) : null;
  }

  async activate(guildId: string, giveawayId: string, at: Date): Promise<Giveaway | null> {
    const [row] = await this.#handle.db
      .update(giveaways)
      .set({ status: 'running', updatedAt: at })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          eq(giveaways.status, 'scheduled'),
        ),
      )
      .returning();

    return row ? toGiveaway(row) : null;
  }

  async dueToStart(guildId: string, before: Date, limit: number): Promise<Giveaway[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.status, 'scheduled'),
          lte(giveaways.startsAt, before),
        ),
      )
      .orderBy(asc(giveaways.startsAt))
      .limit(limit);

    return rows.map(toGiveaway);
  }

  async patch(
    guildId: string,
    giveawayId: string,
    from: readonly GiveawayStatus[],
    patch: GiveawayPatch,
  ): Promise<Giveaway | null> {
    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );

    if (Object.keys(fields).length === 0 || from.length === 0) return null;

    const [row] = await this.#handle.db
      .update(giveaways)
      .set({ ...fields, updatedAt: new Date() })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          inArray(giveaways.status, from as string[]),
        ),
      )
      .returning();

    return row ? toGiveaway(row) : null;
  }

  async leave(giveawayId: string, userId: string, at: Date): Promise<boolean> {
    const rows = await this.#handle.db
      .update(giveawayEntries)
      .set({ leftAt: at })
      .where(
        and(
          eq(giveawayEntries.giveawayId, giveawayId),
          eq(giveawayEntries.userId, userId),
          isNull(giveawayEntries.leftAt),
          isNull(giveawayEntries.disqualifiedAt),
        ),
      )
      .returning({ userId: giveawayEntries.userId });

    return rows.length > 0;
  }

  async resolve(guildId: string, reference: string): Promise<Giveaway | null> {
    const code = parseShortCode(reference);

    if (code !== null) {
      const [row] = await this.#handle.db
        .select()
        .from(giveaways)
        .where(and(eq(giveaways.guildId, guildId), eq(giveaways.shortCode, code)))
        .limit(1);

      if (row) return toGiveaway(row);
    }

    return this.get(guildId, reference);
  }

  async claimDrop(
    guildId: string,
    giveawayId: string,
    userId: string,
    at: Date,
  ): Promise<DropOutcome> {
    return this.#handle.db.transaction(async (tx) => {
      // The whole race, in one statement: two hundred presses land here and Postgres lets exactly
      // one row match `status = 'running'`. That caller is the winner; everybody else sees zero
      // rows and is told somebody was faster.
      const [row] = await tx
        .update(giveaways)
        .set({ status: 'ended', endedAt: at, updatedAt: at })
        .where(
          and(
            eq(giveaways.guildId, guildId),
            eq(giveaways.id, giveawayId),
            eq(giveaways.status, 'running'),
            eq(giveaways.entryMethod, 'drop'),
          ),
        )
        .returning();

      if (!row) {
        const [current] = await tx
          .select({ status: giveaways.status })
          .from(giveaways)
          .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, giveawayId)))
          .limit(1);

        return current === undefined ? { outcome: 'closed' } : { outcome: 'taken' };
      }

      const drawId = `${giveawayId}:drop`;

      await tx.insert(giveawayDraws).values({
        id: drawId,
        giveawayId,
        drawNumber: 1,
        // A drop is not sampled, so there is no seed to reproduce and no snapshot to attest to.
        // The audit row still exists so a drop appears in the ledger like every other result.
        seed: 'drop',
        snapshotHash: 'drop',
        entrantCount: 1,
        totalEntries: 1,
        winnerIds: [userId],
        degradedProviders: [],
        drawnBy: userId,
        reason: 'first eligible presser',
      });

      await tx.insert(giveawayWins).values({ giveawayId, drawId, userId });

      return { outcome: 'won', giveaway: toGiveaway(row), drawId };
    });
  }

  async markRerolled(drawId: string, userIds: readonly string[], at: Date): Promise<number> {
    if (userIds.length === 0) return 0;

    const rows = await this.#handle.db
      .update(giveawayWins)
      .set({ rerolledAt: at })
      .where(
        and(
          eq(giveawayWins.drawId, drawId),
          inArray(giveawayWins.userId, userIds as string[]),
          isNull(giveawayWins.rerolledAt),
        ),
      )
      .returning({ userId: giveawayWins.userId });

    return rows.length;
  }

  async stalledDraws(
    guildId: string,
    before: Date,
    limit: number,
  ): Promise<{ giveaway: Giveaway; drawn: boolean }[]> {
    const rows = await this.#handle.db
      .select({
        row: giveaways,
        drawn: sql<boolean>`exists (
          select 1 from ${giveawayDraws} d
           where d.${sql.raw(giveawayDraws.giveawayId.name)} = ${giveaways.id}
             and d.${sql.raw(giveawayDraws.drawnAt.name)} >= ${giveaways.drawingStartedAt}
        )`,
      })
      .from(giveaways)
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.status, 'drawing'),
          lt(giveaways.drawingStartedAt, before),
        ),
      )
      .orderBy(asc(giveaways.drawingStartedAt))
      .limit(limit);

    return rows.map((entry) => ({ giveaway: toGiveaway(entry.row), drawn: entry.drawn === true }));
  }

  async releaseDraw(guildId: string, giveawayId: string): Promise<boolean> {
    const rows = await this.#handle.db
      .update(giveaways)
      .set({ status: 'running', drawingStartedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.id, giveawayId),
          eq(giveaways.status, 'drawing'),
        ),
      )
      .returning({ id: giveaways.id });

    return rows.length > 0;
  }

  async overdue(guildId: string, before: Date, limit: number): Promise<Giveaway[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(
        and(
          eq(giveaways.guildId, guildId),
          eq(giveaways.status, 'running'),
          lte(giveaways.endsAt, before),
        ),
      )
      .orderBy(asc(giveaways.endsAt))
      .limit(limit);

    return rows.map(toGiveaway);
  }

  async running(guildId: string, limit: number): Promise<Giveaway[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.status, 'running')))
      .orderBy(asc(giveaways.endsAt))
      .limit(limit);

    return rows.map(toGiveaway);
  }

  async draws(giveawayId: string): Promise<DrawRecord[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayDraws)
      .where(eq(giveawayDraws.giveawayId, giveawayId))
      .orderBy(asc(giveawayDraws.drawNumber));

    return rows.map((row) => ({
      id: row.id,
      giveawayId: row.giveawayId,
      drawNumber: row.drawNumber,
      seed: row.seed,
      snapshotHash: row.snapshotHash,
      entrantCount: row.entrantCount,
      totalEntries: row.totalEntries,
      winnerIds: row.winnerIds,
      degradedProviders: row.degradedProviders,
      drawnAt: row.drawnAt,
      drawnBy: row.drawnBy,
      reason: row.reason,
    }));
  }

  async lastDrawNumber(giveawayId: string): Promise<number> {
    const [row] = await this.#handle.db
      .select({ value: sql<number>`coalesce(max(${giveawayDraws.drawNumber}), 0)` })
      .from(giveawayDraws)
      .where(eq(giveawayDraws.giveawayId, giveawayId));

    return Number(row?.value ?? 0);
  }

  async winners(giveawayId: string): Promise<WinRecord[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayWins)
      .where(eq(giveawayWins.giveawayId, giveawayId));

    return rows.map((row) => ({
      giveawayId: row.giveawayId,
      drawId: row.drawId,
      userId: row.userId,
      claimedAt: row.claimedAt,
      forfeitedAt: row.forfeitedAt,
      rerolledAt: row.rerolledAt,
      claimDeadline: row.claimDeadline,
    }));
  }

  // The deadline is enforced here, not only by the expiry sweep: the sweep runs on an interval, so
  // without this a winner can still claim in the gap after their window closed.
  async claim(drawId: string, userId: string, at: Date): Promise<boolean> {
    const rows = await this.#handle.db
      .update(giveawayWins)
      .set({ claimedAt: at })
      .where(
        and(
          eq(giveawayWins.drawId, drawId),
          eq(giveawayWins.userId, userId),
          isNull(giveawayWins.claimedAt),
          isNull(giveawayWins.forfeitedAt),
          or(isNull(giveawayWins.claimDeadline), gt(giveawayWins.claimDeadline, at)),
        ),
      )
      .returning({ userId: giveawayWins.userId });

    return rows.length > 0;
  }

  async forfeit(drawId: string, userIds: readonly string[], at: Date): Promise<number> {
    if (userIds.length === 0) return 0;

    const rows = await this.#handle.db
      .update(giveawayWins)
      .set({ forfeitedAt: at })
      .where(
        and(
          eq(giveawayWins.drawId, drawId),
          inArray(giveawayWins.userId, [...userIds]),
          isNull(giveawayWins.claimedAt),
          isNull(giveawayWins.forfeitedAt),
        ),
      )
      .returning({ userId: giveawayWins.userId });

    return rows.length;
  }

  // giveaway_wins carries no guild_id, so the guild predicate has to come off the parent row.
  async expiredClaims(guildId: string, before: Date, limit: number): Promise<WinRecord[]> {
    const rows = await this.#handle.db
      .select({ win: giveawayWins })
      .from(giveawayWins)
      .innerJoin(giveaways, eq(giveaways.id, giveawayWins.giveawayId))
      .where(
        and(
          eq(giveaways.guildId, guildId),
          isNull(giveawayWins.claimedAt),
          isNull(giveawayWins.forfeitedAt),
          lt(giveawayWins.claimDeadline, before),
        ),
      )
      .orderBy(asc(giveawayWins.claimDeadline))
      .limit(limit);

    return rows.map(({ win: row }) => ({
      giveawayId: row.giveawayId,
      drawId: row.drawId,
      userId: row.userId,
      claimedAt: row.claimedAt,
      forfeitedAt: row.forfeitedAt,
      rerolledAt: row.rerolledAt,
      claimDeadline: row.claimDeadline,
    }));
  }

  async recentWinCounts(
    guildId: string,
    userIds: readonly string[],
    since: Date,
    templateId?: string | null,
  ): Promise<Map<string, number>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();

    const filters = [
      eq(giveaways.guildId, guildId),
      inArray(giveawayWins.userId, ids),
      gte(giveawayDraws.drawnAt, since),
      // A forfeited win is not a win: somebody who never claimed should not be locked out of the
      // next giveaway by a prize they never received.
      isNull(giveawayWins.forfeitedAt),
    ];

    if (templateId !== undefined && templateId !== null) {
      filters.push(eq(giveaways.templateId, templateId));
    }

    const rows = await this.#handle.db
      .select({ userId: giveawayWins.userId, value: count() })
      .from(giveawayWins)
      .innerJoin(giveawayDraws, eq(giveawayWins.drawId, giveawayDraws.id))
      .innerJoin(giveaways, eq(giveawayWins.giveawayId, giveaways.id))
      .where(and(...filters))
      .groupBy(giveawayWins.userId);

    return new Map(rows.map((row) => [row.userId, row.value]));
  }

  async priorEntryCounts(
    guildId: string,
    userIds: readonly string[],
    since: Date,
  ): Promise<Map<string, number>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();

    const rows = await this.#handle.db
      .select({ userId: giveawayEntries.userId, value: count() })
      .from(giveawayEntries)
      .innerJoin(giveaways, eq(giveawayEntries.giveawayId, giveaways.id))
      .where(
        and(
          eq(giveaways.guildId, guildId),
          inArray(giveawayEntries.userId, ids),
          gte(giveawayEntries.joinedAt, since),
        ),
      )
      .groupBy(giveawayEntries.userId);

    return new Map(rows.map((row) => [row.userId, row.value]));
  }

  async blacklist(guildId: string): Promise<BlacklistEntry[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayBlacklist)
      .where(eq(giveawayBlacklist.guildId, guildId));

    return rows.map((row) => ({
      subjectType: row.subjectType === 'role' ? 'role' : 'user',
      subjectId: row.subjectId,
      addedBy: row.addedBy,
      reason: row.reason,
    }));
  }

  async addBlacklist(guildId: string, entry: BlacklistEntry): Promise<boolean> {
    const rows = await this.#handle.db
      .insert(giveawayBlacklist)
      .values({
        guildId,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        addedBy: entry.addedBy,
        reason: entry.reason,
      })
      .onConflictDoNothing()
      .returning({ subjectId: giveawayBlacklist.subjectId });

    return rows.length > 0;
  }

  async removeBlacklist(
    guildId: string,
    subjectType: BlacklistSubject,
    subjectId: string,
  ): Promise<boolean> {
    const rows = await this.#handle.db
      .delete(giveawayBlacklist)
      .where(
        and(
          eq(giveawayBlacklist.guildId, guildId),
          eq(giveawayBlacklist.subjectType, subjectType),
          eq(giveawayBlacklist.subjectId, subjectId),
        ),
      )
      .returning({ subjectId: giveawayBlacklist.subjectId });

    return rows.length > 0;
  }

  async saveTemplate(input: Omit<TemplateRecord, 'createdAt'>): Promise<TemplateRecord> {
    const [row] = await this.#handle.db
      .insert(giveawayTemplates)
      .values({
        id: input.id,
        guildId: input.guildId,
        name: input.name,
        payload: input.payload,
        createdBy: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [giveawayTemplates.guildId, giveawayTemplates.name],
        set: { payload: input.payload, createdBy: input.createdBy },
      })
      .returning();

    if (!row) throw new Error('giveaway template upsert returned no row');

    return {
      id: row.id,
      guildId: row.guildId,
      name: row.name,
      payload: row.payload,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  async template(guildId: string, name: string): Promise<TemplateRecord | null> {
    const [row] = await this.#handle.db
      .select()
      .from(giveawayTemplates)
      .where(and(eq(giveawayTemplates.guildId, guildId), eq(giveawayTemplates.name, name)))
      .limit(1);

    return row
      ? {
          id: row.id,
          guildId: row.guildId,
          name: row.name,
          payload: row.payload,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        }
      : null;
  }

  async templates(guildId: string): Promise<TemplateRecord[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayTemplates)
      .where(eq(giveawayTemplates.guildId, guildId))
      .orderBy(asc(giveawayTemplates.name));

    return rows.map((row) => ({
      id: row.id,
      guildId: row.guildId,
      name: row.name,
      payload: row.payload,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
  }

  async deleteTemplate(guildId: string, name: string): Promise<boolean> {
    const rows = await this.#handle.db
      .delete(giveawayTemplates)
      .where(and(eq(giveawayTemplates.guildId, guildId), eq(giveawayTemplates.name, name)))
      .returning({ id: giveawayTemplates.id });

    return rows.length > 0;
  }
}
