import type { DbHandle } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { eq, sql } from 'drizzle-orm';

export interface EnsureGuildInput {
  guildId: string;
  name: string;
  locale?: string | undefined;
  shardId?: number | undefined;
}

/**
 * Guild lifecycle.
 *
 * `guild_modules.guild_id` is a foreign key to `guilds`, so until a guild has a
 * row here it cannot have module config at all — every lookup falls through to
 * defaults and reports `enabled: false`. The bot appears to be in the server,
 * caches its state, answers nothing, and offers no clue why. That is exactly the
 * "the bot did nothing" outcome §7 exists to eliminate, so registration happens
 * automatically on GUILD_CREATE rather than waiting for someone to save a
 * setting in the dashboard.
 */
export class GuildService {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  /**
   * Idempotent: GUILD_CREATE arrives on every gateway connect and on every
   * RESUME, so this runs constantly for guilds already known.
   *
   * `leftAt` is cleared on conflict — a guild the bot was removed from and later
   * re-added to must come back as active, and its existing module config is
   * still there and should keep working.
   */
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

  /**
   * The bot was removed from the guild.
   *
   * A soft mark, never a delete: `cases`, `audit_trail` and `guild_modules` all
   * cascade from this row, so deleting it would destroy a server's entire
   * moderation history the moment someone kicks the bot — including history they
   * may need precisely because they kicked it.
   */
  async markLeft(guildId: string): Promise<void> {
    await this.#db.db.update(guilds).set({ leftAt: new Date() }).where(eq(guilds.id, guildId));
  }
}
