import type { DbHandle } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

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

  async markLeft(guildId: string): Promise<void> {
    await this.#db.db.update(guilds).set({ leftAt: new Date() }).where(eq(guilds.id, guildId));
  }

  async presentIn(guildIds: readonly string[]): Promise<string[]> {
    // `inArray` with an empty list compiles to invalid SQL, so the guard is load-bearing.
    if (guildIds.length === 0) return [];

    const rows = await this.#db.db
      .select({ id: guilds.id })
      .from(guilds)
      .where(and(inArray(guilds.id, [...guildIds]), isNull(guilds.leftAt)));

    return rows.map((row) => row.id);
  }
}
