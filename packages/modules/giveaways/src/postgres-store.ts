import { newId } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type {
  BlacklistEntry,
  BlacklistSubject,
  CreateGiveawayInput,
  Disqualification,
  DrawRecord,
  EnterOutcome,
  EntrantRow,
  Giveaway,
  GiveawayStatus,
  GiveawayStore,
  ListGiveawaysQuery,
  MemberSnapshot,
  MultiplierRow,
  NewEntry,
  RecordDrawInput,
  RequirementRow,
  Reweigh,
  TemplateRecord,
  WinRecord,
} from './store.ts';
import {
  type GiveawayRow,
  giveawayBlacklist,
  giveawayDraws,
  giveawayEntries,
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
    maxEntriesPerUser: row.maxEntriesPerUser,
    verifyOn: row.verifyOn === 'join' ? 'join' : row.verifyOn === 'draw' ? 'draw' : 'both',
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    endedAt: row.endedAt,
    status: row.status as GiveawayStatus,
    drawingStartedAt: row.drawingStartedAt,
    claimWindowSeconds: row.claimWindowSeconds,
    dmWinners: row.dmWinners,
    winMessage: row.winMessage,
    templateId: row.templateId,
    recurrence: row.recurrence,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
          maxEntriesPerUser: input.maxEntriesPerUser ?? null,
          verifyOn: input.verifyOn ?? 'both',
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt,
          status: input.status ?? 'running',
          claimWindowSeconds: input.claimWindowSeconds ?? null,
          dmWinners: input.dmWinners ?? false,
          winMessage: input.winMessage ?? null,
          templateId: input.templateId ?? null,
          recurrence: input.recurrence ?? null,
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

    if (query.state === 'running') filters.push(eq(giveaways.status, 'running'));
    if (query.state === 'ended') filters.push(inArray(giveaways.status, ['ended', 'cancelled']));
    if (query.prefix) {
      filters.push(sql`lower(${giveaways.title}) like ${`${query.prefix.toLowerCase()}%`}`);
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

  async enter(entry: NewEntry): Promise<EnterOutcome> {
    const inserted = await this.#handle.db
      .insert(giveawayEntries)
      .values({
        giveawayId: entry.giveawayId,
        userId: entry.userId,
        baseEntries: entry.baseEntries,
        totalEntries: entry.totalEntries,
        breakdown: entry.breakdown,
        memberSnapshot: entry.memberSnapshot,
      })
      .onConflictDoNothing()
      .returning({ userId: giveawayEntries.userId });

    return inserted.length > 0 ? 'entered' : 'already-entered';
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
        and(eq(giveawayEntries.giveawayId, giveawayId), isNull(giveawayEntries.disqualifiedAt)),
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
        and(eq(giveawayEntries.giveawayId, giveawayId), isNull(giveawayEntries.disqualifiedAt)),
      )
      .orderBy(desc(giveawayEntries.totalEntries), asc(giveawayEntries.userId))
      .limit(limit);

    return rows.map((row) => ({
      userId: row.userId,
      totalEntries: row.totalEntries,
      memberSnapshot: toSnapshot(row.memberSnapshot),
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

  async reweigh(giveawayId: string, rows: readonly Reweigh[], at: Date): Promise<number> {
    if (rows.length === 0) return 0;

    let updated = 0;
    await this.#handle.db.transaction(async (tx) => {
      for (const row of rows) {
        const result = await tx
          .update(giveawayEntries)
          .set({ totalEntries: row.totalEntries, breakdown: row.breakdown, revalidatedAt: at })
          .where(
            and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.userId, row.userId)),
          )
          .returning({ userId: giveawayEntries.userId });

        updated += result.length;
      }
    });

    return updated;
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
    status: GiveawayStatus,
    endedAt: Date | null,
  ): Promise<boolean> {
    const rows = await this.#handle.db
      .update(giveaways)
      .set({ status, endedAt, drawingStartedAt: null, updatedAt: new Date() })
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, giveawayId)))
      .returning({ id: giveaways.id });

    return rows.length > 0;
  }

  async stalledDraws(
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
      .where(and(eq(giveaways.status, 'drawing'), lt(giveaways.drawingStartedAt, before)))
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

  async overdue(before: Date, limit: number): Promise<Giveaway[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(and(eq(giveaways.status, 'running'), lte(giveaways.endsAt, before)))
      .orderBy(asc(giveaways.endsAt))
      .limit(limit);

    return rows.map(toGiveaway);
  }

  async running(limit: number): Promise<Giveaway[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveaways)
      .where(eq(giveaways.status, 'running'))
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

  async expiredClaims(before: Date, limit: number): Promise<WinRecord[]> {
    const rows = await this.#handle.db
      .select()
      .from(giveawayWins)
      .where(
        and(
          isNull(giveawayWins.claimedAt),
          isNull(giveawayWins.forfeitedAt),
          lt(giveawayWins.claimDeadline, before),
        ),
      )
      .limit(limit);

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
