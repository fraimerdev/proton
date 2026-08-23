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
  MultiplierRow,
  NewEntry,
  RecordDrawInput,
  RequirementRow,
  Reweigh,
  TemplateRecord,
  WinRecord,
} from '../src/store.ts';

interface EntryRow extends EntrantRow {
  giveawayId: string;
  baseEntries: number;
  breakdown: unknown;
  joinedAt: Date;
  revalidatedAt: Date | null;
  disqualifiedAt: Date | null;
  disqualifyReason: string | null;
}

/**
 * An in-memory GiveawayStore with the same concurrency semantics as the Drizzle one: `beginDraw`
 * is a conditional swap and `recordDraw` refuses a duplicate (giveaway, draw number). Those two
 * are what exactly-once rests on, so testing them here proves the logic on a host where
 * Testcontainers cannot reach Docker.
 */
export class MemoryGiveawayStore implements GiveawayStore {
  readonly giveaways = new Map<string, Giveaway>();
  readonly requirementRows = new Map<string, RequirementRow[]>();
  readonly multiplierRows = new Map<string, MultiplierRow[]>();
  readonly entries: EntryRow[] = [];
  readonly drawRows: DrawRecord[] = [];
  readonly winRows: WinRecord[] = [];
  readonly blacklistRows = new Map<string, BlacklistEntry[]>();
  readonly templateRows = new Map<string, TemplateRecord>();

  /** Every read that would be a SQL statement, so a test can assert O(requirements), not O(n). */
  readonly queries: string[] = [];

  #record(name: string): void {
    this.queries.push(name);
  }

  async create(input: CreateGiveawayInput): Promise<Giveaway> {
    const now = new Date();
    const giveaway: Giveaway = {
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
      endedAt: null,
      status: input.status ?? 'running',
      drawingStartedAt: null,
      claimWindowSeconds: input.claimWindowSeconds ?? null,
      dmWinners: input.dmWinners ?? false,
      winMessage: input.winMessage ?? null,
      templateId: input.templateId ?? null,
      recurrence: input.recurrence ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.giveaways.set(giveaway.id, giveaway);

    this.requirementRows.set(
      giveaway.id,
      (input.requirements ?? []).map((row, index) => ({
        ...row,
        id: `r${index}`,
        position: index,
      })),
    );
    this.multiplierRows.set(
      giveaway.id,
      (input.multipliers ?? []).map((row, index) => ({ ...row, id: `m${index}`, position: index })),
    );

    return giveaway;
  }

  async get(guildId: string, giveawayId: string): Promise<Giveaway | null> {
    const giveaway = this.giveaways.get(giveawayId);
    return giveaway && giveaway.guildId === guildId ? { ...giveaway } : null;
  }

  async byMessage(guildId: string, messageId: string): Promise<Giveaway | null> {
    for (const giveaway of this.giveaways.values()) {
      if (giveaway.guildId === guildId && giveaway.messageId === messageId) return { ...giveaway };
    }
    return null;
  }

  async list(query: ListGiveawaysQuery): Promise<Giveaway[]> {
    return [...this.giveaways.values()]
      .filter((giveaway) => giveaway.guildId === query.guildId)
      .filter((giveaway) =>
        query.state === 'running'
          ? giveaway.status === 'running'
          : query.state === 'ended'
            ? giveaway.status === 'ended' || giveaway.status === 'cancelled'
            : true,
      )
      .slice(0, query.limit);
  }

  async countRunning(guildId: string): Promise<number> {
    return [...this.giveaways.values()].filter(
      (giveaway) => giveaway.guildId === guildId && giveaway.status === 'running',
    ).length;
  }

  async setMessageId(giveawayId: string, messageId: string): Promise<void> {
    const giveaway = this.giveaways.get(giveawayId);
    if (giveaway) this.giveaways.set(giveawayId, { ...giveaway, messageId });
  }

  async requirements(giveawayId: string): Promise<RequirementRow[]> {
    this.#record('requirements');
    return [...(this.requirementRows.get(giveawayId) ?? [])];
  }

  async multipliers(giveawayId: string): Promise<MultiplierRow[]> {
    this.#record('multipliers');
    return [...(this.multiplierRows.get(giveawayId) ?? [])];
  }

  async enter(entry: NewEntry): Promise<EnterOutcome> {
    const existing = this.entries.find(
      (row) => row.giveawayId === entry.giveawayId && row.userId === entry.userId,
    );
    if (existing) return 'already-entered';

    this.entries.push({
      giveawayId: entry.giveawayId,
      userId: entry.userId,
      baseEntries: entry.baseEntries,
      totalEntries: entry.totalEntries,
      breakdown: entry.breakdown,
      memberSnapshot: entry.memberSnapshot,
      joinedAt: new Date(),
      revalidatedAt: null,
      disqualifiedAt: null,
      disqualifyReason: null,
    });

    return 'entered';
  }

  async entry(giveawayId: string, userId: string): Promise<EntrantRow | null> {
    this.#record('entry');
    const row = this.entries.find(
      (entry) => entry.giveawayId === giveawayId && entry.userId === userId,
    );

    return row
      ? { userId: row.userId, totalEntries: row.totalEntries, memberSnapshot: row.memberSnapshot }
      : null;
  }

  async entrantCount(giveawayId: string): Promise<number> {
    this.#record('entrantCount');
    return this.entries.filter(
      (row) => row.giveawayId === giveawayId && row.disqualifiedAt === null,
    ).length;
  }

  async entrantCounts(giveawayIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const id of giveawayIds) counts.set(id, await this.entrantCount(id));
    return counts;
  }

  async *entrants(giveawayId: string, chunkSize: number): AsyncIterable<EntrantRow[]> {
    const live = this.entries
      .filter((row) => row.giveawayId === giveawayId && row.disqualifiedAt === null)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

    for (let index = 0; index < live.length; index += chunkSize) {
      this.#record('entrants');
      yield live.slice(index, index + chunkSize).map((row) => ({
        userId: row.userId,
        totalEntries: row.totalEntries,
        memberSnapshot: row.memberSnapshot,
      }));
    }
  }

  async topEntrants(giveawayId: string, limit: number): Promise<EntrantRow[]> {
    this.#record('topEntrants');

    return this.entries
      .filter((row) => row.giveawayId === giveawayId && row.disqualifiedAt === null)
      .sort((a, b) => b.totalEntries - a.totalEntries || (a.userId < b.userId ? -1 : 1))
      .slice(0, limit)
      .map((row) => ({
        userId: row.userId,
        totalEntries: row.totalEntries,
        memberSnapshot: row.memberSnapshot,
      }));
  }

  async disqualify(
    giveawayId: string,
    rows: readonly Disqualification[],
    at: Date,
  ): Promise<number> {
    if (rows.length > 0) this.#record('disqualify');

    let updated = 0;
    for (const drop of rows) {
      const row = this.entries.find(
        (entry) =>
          entry.giveawayId === giveawayId &&
          entry.userId === drop.userId &&
          entry.disqualifiedAt === null,
      );

      if (!row) continue;
      row.disqualifiedAt = at;
      row.disqualifyReason = drop.reason;
      row.revalidatedAt = at;
      updated += 1;
    }

    return updated;
  }

  async reweigh(giveawayId: string, rows: readonly Reweigh[], at: Date): Promise<number> {
    if (rows.length > 0) this.#record('reweigh');

    let updated = 0;
    for (const change of rows) {
      const row = this.entries.find(
        (entry) => entry.giveawayId === giveawayId && entry.userId === change.userId,
      );
      if (!row) continue;

      row.totalEntries = change.totalEntries;
      row.breakdown = change.breakdown;
      row.revalidatedAt = at;
      updated += 1;
    }

    return updated;
  }

  // The conditional update, modelled exactly: only a `running` giveaway moves, and only once.
  async beginDraw(guildId: string, giveawayId: string, at: Date): Promise<Giveaway | null> {
    const giveaway = this.giveaways.get(giveawayId);
    if (!giveaway || giveaway.guildId !== guildId || giveaway.status !== 'running') return null;

    const moved: Giveaway = {
      ...giveaway,
      status: 'drawing',
      drawingStartedAt: at,
      updatedAt: at,
    };
    this.giveaways.set(giveawayId, moved);

    return { ...moved };
  }

  async recordDraw(input: RecordDrawInput): Promise<{ drawId: string } | 'already-drawn'> {
    const clash = this.drawRows.find(
      (row) => row.giveawayId === input.giveawayId && row.drawNumber === input.drawNumber,
    );
    if (clash) return 'already-drawn';

    this.drawRows.push({
      id: input.id,
      giveawayId: input.giveawayId,
      drawNumber: input.drawNumber,
      seed: input.seed,
      snapshotHash: input.snapshotHash,
      entrantCount: input.entrantCount,
      totalEntries: input.totalEntries,
      winnerIds: [...input.winnerIds],
      degradedProviders: [...input.degradedProviders],
      drawnAt: new Date(),
      drawnBy: input.drawnBy,
      reason: input.reason ?? null,
    });

    for (const userId of input.winnerIds) {
      this.winRows.push({
        giveawayId: input.giveawayId,
        drawId: input.id,
        userId,
        claimedAt: null,
        forfeitedAt: null,
        rerolledAt: null,
        claimDeadline: input.claimDeadline ?? null,
      });
    }

    return { drawId: input.id };
  }

  async finishDraw(
    guildId: string,
    giveawayId: string,
    status: GiveawayStatus,
    endedAt: Date | null,
  ): Promise<boolean> {
    const giveaway = this.giveaways.get(giveawayId);
    if (!giveaway || giveaway.guildId !== guildId) return false;

    this.giveaways.set(giveawayId, {
      ...giveaway,
      status,
      endedAt,
      drawingStartedAt: null,
      updatedAt: new Date(),
    });

    return true;
  }

  async stalledDraws(
    before: Date,
    limit: number,
  ): Promise<{ giveaway: Giveaway; drawn: boolean }[]> {
    return [...this.giveaways.values()]
      .filter(
        (giveaway) =>
          giveaway.status === 'drawing' &&
          giveaway.drawingStartedAt !== null &&
          giveaway.drawingStartedAt < before,
      )
      .slice(0, limit)
      .map((giveaway) => ({
        giveaway: { ...giveaway },
        drawn: this.drawRows.some(
          (row) =>
            row.giveawayId === giveaway.id &&
            giveaway.drawingStartedAt !== null &&
            row.drawnAt >= giveaway.drawingStartedAt,
        ),
      }));
  }

  async releaseDraw(guildId: string, giveawayId: string): Promise<boolean> {
    const giveaway = this.giveaways.get(giveawayId);
    if (!giveaway || giveaway.guildId !== guildId || giveaway.status !== 'drawing') return false;

    this.giveaways.set(giveawayId, {
      ...giveaway,
      status: 'running',
      drawingStartedAt: null,
    });

    return true;
  }

  async overdue(before: Date, limit: number): Promise<Giveaway[]> {
    return [...this.giveaways.values()]
      .filter((giveaway) => giveaway.status === 'running' && giveaway.endsAt <= before)
      .slice(0, limit)
      .map((giveaway) => ({ ...giveaway }));
  }

  async running(limit: number): Promise<Giveaway[]> {
    return [...this.giveaways.values()]
      .filter((giveaway) => giveaway.status === 'running')
      .slice(0, limit)
      .map((giveaway) => ({ ...giveaway }));
  }

  async draws(giveawayId: string): Promise<DrawRecord[]> {
    return this.drawRows
      .filter((row) => row.giveawayId === giveawayId)
      .sort((a, b) => a.drawNumber - b.drawNumber);
  }

  async lastDrawNumber(giveawayId: string): Promise<number> {
    return this.drawRows
      .filter((row) => row.giveawayId === giveawayId)
      .reduce((max, row) => Math.max(max, row.drawNumber), 0);
  }

  async winners(giveawayId: string): Promise<WinRecord[]> {
    return this.winRows.filter((row) => row.giveawayId === giveawayId).map((row) => ({ ...row }));
  }

  async claim(drawId: string, userId: string, at: Date): Promise<boolean> {
    const row = this.winRows.find(
      (win) =>
        win.drawId === drawId &&
        win.userId === userId &&
        win.claimedAt === null &&
        win.forfeitedAt === null,
    );
    if (!row) return false;

    row.claimedAt = at;
    return true;
  }

  async forfeit(drawId: string, userIds: readonly string[], at: Date): Promise<number> {
    let count = 0;
    for (const userId of userIds) {
      const row = this.winRows.find(
        (win) =>
          win.drawId === drawId &&
          win.userId === userId &&
          win.claimedAt === null &&
          win.forfeitedAt === null,
      );
      if (!row) continue;

      row.forfeitedAt = at;
      count += 1;
    }
    return count;
  }

  async expiredClaims(before: Date, limit: number): Promise<WinRecord[]> {
    return this.winRows
      .filter(
        (row) =>
          row.claimedAt === null &&
          row.forfeitedAt === null &&
          row.claimDeadline !== null &&
          row.claimDeadline < before,
      )
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async recentWinCounts(
    guildId: string,
    userIds: readonly string[],
    since: Date,
    templateId?: string | null,
  ): Promise<Map<string, number>> {
    this.#record('recentWinCounts');

    const wanted = new Set(userIds);
    const counts = new Map<string, number>();

    for (const win of this.winRows) {
      if (!wanted.has(win.userId) || win.forfeitedAt !== null) continue;

      const giveaway = this.giveaways.get(win.giveawayId);
      if (!giveaway || giveaway.guildId !== guildId) continue;
      if (templateId != null && giveaway.templateId !== templateId) continue;

      const draw = this.drawRows.find((row) => row.id === win.drawId);
      if (!draw || draw.drawnAt < since) continue;

      counts.set(win.userId, (counts.get(win.userId) ?? 0) + 1);
    }

    return counts;
  }

  async priorEntryCounts(
    guildId: string,
    userIds: readonly string[],
    since: Date,
  ): Promise<Map<string, number>> {
    this.#record('priorEntryCounts');

    const wanted = new Set(userIds);
    const counts = new Map<string, number>();

    for (const row of this.entries) {
      if (!wanted.has(row.userId) || row.joinedAt < since) continue;

      const giveaway = this.giveaways.get(row.giveawayId);
      if (!giveaway || giveaway.guildId !== guildId) continue;

      counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
    }

    return counts;
  }

  async blacklist(guildId: string): Promise<BlacklistEntry[]> {
    return [...(this.blacklistRows.get(guildId) ?? [])];
  }

  async addBlacklist(guildId: string, entry: BlacklistEntry): Promise<boolean> {
    const rows = this.blacklistRows.get(guildId) ?? [];
    if (
      rows.some((row) => row.subjectType === entry.subjectType && row.subjectId === entry.subjectId)
    ) {
      return false;
    }

    rows.push(entry);
    this.blacklistRows.set(guildId, rows);
    return true;
  }

  async removeBlacklist(
    guildId: string,
    subjectType: BlacklistSubject,
    subjectId: string,
  ): Promise<boolean> {
    const rows = this.blacklistRows.get(guildId) ?? [];
    const next = rows.filter(
      (row) => !(row.subjectType === subjectType && row.subjectId === subjectId),
    );

    this.blacklistRows.set(guildId, next);
    return next.length !== rows.length;
  }

  async saveTemplate(input: Omit<TemplateRecord, 'createdAt'>): Promise<TemplateRecord> {
    const record: TemplateRecord = { ...input, createdAt: new Date() };
    this.templateRows.set(`${input.guildId}:${input.name}`, record);
    return record;
  }

  async template(guildId: string, name: string): Promise<TemplateRecord | null> {
    return this.templateRows.get(`${guildId}:${name}`) ?? null;
  }

  async templates(guildId: string): Promise<TemplateRecord[]> {
    return [...this.templateRows.values()].filter((row) => row.guildId === guildId);
  }

  async deleteTemplate(guildId: string, name: string): Promise<boolean> {
    return this.templateRows.delete(`${guildId}:${name}`);
  }
}
