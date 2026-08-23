import type { DbHandle } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

export interface GuildOverview {
  id: string;
  name: string;
  locale: string;
  tier: string;
  joinedAt: string;
}

export interface EnsureGuildInput {
  guildId: string;
  name: string;
  locale?: string | undefined;
  shardId?: number | undefined;
}

export class GuildService {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  async ensureGuild(input: EnsureGuildInput): Promise<void> {
    await this.#db.db
      .insert(guilds)
      .values({
        id: input.guildId,
        name: input.name,
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.shardId !== undefined ? { shardId: input.shardId } : {}),
      })
      .onConflictDoUpdate({
        target: guilds.id,
        set: {
          name: input.name,
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.shardId !== undefined ? { shardId: input.shardId } : {}),
          leftAt: sql`null`,
        },
      });
  }

  async overview(guildId: string): Promise<GuildOverview | null> {
    const rows = await this.#db.db
      .select({
        id: guilds.id,
        name: guilds.name,
        locale: guilds.locale,
        tier: guilds.tier,
        joinedAt: guilds.joinedAt,
      })
      .from(guilds)
      .where(eq(guilds.id, guildId))
      .limit(1);

    const row = rows[0];
    return row ? { ...row, joinedAt: row.joinedAt.toISOString() } : null;
  }

  // leftAt, not row-exists: the row outlives a kick so cases and config survive a re-invite, and
  // an id filtered out here is one the dashboard would otherwise offer as configurable.
  async presentIds(guildIds: readonly string[]): Promise<string[]> {
    if (guildIds.length === 0) return [];

    const rows = await this.#db.db
      .select({ id: guilds.id })
      .from(guilds)
      .where(and(inArray(guilds.id, [...guildIds]), isNull(guilds.leftAt)));

    return rows.map((row) => row.id);
  }

  async markLeft(guildId: string): Promise<void> {
    await this.#db.db.update(guilds).set({ leftAt: new Date() }).where(eq(guilds.id, guildId));
  }
}
