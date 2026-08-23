import type { DbHandle } from '@proton/db';
import { members } from '@proton/db';
import { and, desc, eq, gt, gte, inArray, lt, sql, sum } from 'drizzle-orm';
import {
  type ActivityQuery,
  type ActivityStore,
  type ActivityTotals,
  type MemberStats,
  utcDay,
  windowStart,
} from './activity.ts';
import { memberActivityDaily } from './activity-table.ts';

export interface ActivityStoreOptions {
  levelForXp(xp: number): number;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class DrizzleActivityStore implements ActivityStore {
  readonly #handle: DbHandle;
  readonly #levelForXp: (xp: number) => number;

  constructor(handle: DbHandle, options: ActivityStoreOptions) {
    this.#handle = handle;
    this.#levelForXp = options.levelForXp;
  }

  async totals(query: ActivityQuery): Promise<Map<string, ActivityTotals>> {
    const userIds = [...new Set(query.userIds)];
    if (userIds.length === 0) return new Map();

    if (query.window === 'lifetime') {
      const rows = await this.#handle.db
        .select({
          userId: members.userId,
          messageCount: members.messageCount,
          voiceSeconds: members.voiceSeconds,
        })
        .from(members)
        .where(and(eq(members.guildId, query.guildId), inArray(members.userId, userIds)));

      return new Map(
        rows.map((row) => [
          row.userId,
          { messageCount: row.messageCount, voiceSeconds: row.voiceSeconds },
        ]),
      );
    }

    const start = windowStart(query.window, query.now);
    if (start === null) return new Map();

    const rows = await this.#handle.db
      .select({
        userId: memberActivityDaily.userId,
        messageCount: sum(memberActivityDaily.messageCount),
        voiceSeconds: sum(memberActivityDaily.voiceSeconds),
      })
      .from(memberActivityDaily)
      .where(
        and(
          eq(memberActivityDaily.guildId, query.guildId),
          inArray(memberActivityDaily.userId, userIds),
          gte(memberActivityDaily.day, utcDay(start)),
        ),
      )
      .groupBy(memberActivityDaily.userId);

    return new Map(
      rows.map((row) => [
        row.userId,
        {
          messageCount: toNumber(row.messageCount),
          voiceSeconds: toNumber(row.voiceSeconds),
        },
      ]),
    );
  }

  async stats(guildId: string, userIds: readonly string[]): Promise<Map<string, MemberStats>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();

    const rows = await this.#handle.db
      .select({
        userId: members.userId,
        xp: members.xp,
        messageCount: members.messageCount,
        voiceSeconds: members.voiceSeconds,
      })
      .from(members)
      .where(and(eq(members.guildId, guildId), inArray(members.userId, ids)));

    return new Map(
      rows.map((row) => [
        row.userId,
        {
          xp: row.xp,
          // Not members.level: the stored column trails the curve until the next award, and a
          // rank condition that reads a stale level locks somebody out of a giveaway they earned.
          level: this.#levelForXp(row.xp),
          messageCount: row.messageCount,
          voiceSeconds: row.voiceSeconds,
        },
      ]),
    );
  }

  async topRanked(guildId: string, n: number): Promise<string[]> {
    if (n <= 0) return [];

    const rows = await this.#handle.db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.guildId, guildId), gt(members.xp, 0)))
      .orderBy(desc(members.xp), members.userId)
      .limit(n);

    return rows.map((row) => row.userId);
  }

  async prune(before: Date): Promise<number> {
    const rows = await this.#handle.db
      .delete(memberActivityDaily)
      .where(lt(memberActivityDaily.day, utcDay(before)))
      .returning({ userId: memberActivityDaily.userId });

    return rows.length;
  }

  async recordMessage(guildId: string, userId: string, at: Date): Promise<void> {
    await this.#handle.db
      .insert(memberActivityDaily)
      .values({ guildId, userId, day: utcDay(at), messageCount: 1 })
      .onConflictDoUpdate({
        target: [memberActivityDaily.guildId, memberActivityDaily.userId, memberActivityDaily.day],
        set: { messageCount: sql`${memberActivityDaily.messageCount} + 1` },
      });
  }

  async recordVoice(guildId: string, userId: string, seconds: number, at: Date): Promise<void> {
    if (seconds <= 0) return;

    await this.#handle.db
      .insert(memberActivityDaily)
      .values({ guildId, userId, day: utcDay(at), voiceSeconds: seconds })
      .onConflictDoUpdate({
        target: [memberActivityDaily.guildId, memberActivityDaily.userId, memberActivityDaily.day],
        set: { voiceSeconds: sql`${memberActivityDaily.voiceSeconds} + ${seconds}` },
      });
  }
}
