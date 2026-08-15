import type { DbHandle } from '@proton/db';
import { and, eq } from 'drizzle-orm';
import type { StarboardPost, StarboardStore } from './store.ts';
import { starboardPosts } from './table.ts';

/**
 * Postgres implementation of `starboard_posts`.
 *
 * Every statement is scoped by guild as well as by message id. A message id is
 * unique across Discord, so the guild is not needed to find the row — but it is
 * needed to make sure one guild's reaction can never reach another guild's board
 * post, and a store that only trusts the id would make that a one-typo bug (I6's
 * rule: a client-supplied id is never trusted on its own).
 */
export class DrizzleStarboardStore implements StarboardStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async get(guildId: string, sourceMessageId: string): Promise<StarboardPost | null> {
    const rows = await this.#handle.db
      .select()
      .from(starboardPosts)
      .where(
        and(
          eq(starboardPosts.guildId, guildId),
          eq(starboardPosts.sourceMessageId, sourceMessageId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      guildId: row.guildId,
      sourceMessageId: row.sourceMessageId,
      boardMessageId: row.boardMessageId,
      starCount: row.starCount,
      createdAt: row.createdAt,
    };
  }

  /**
   * `ON CONFLICT DO NOTHING` on the primary key, so the second of two concurrent
   * creates records nothing and says so instead of raising a unique violation
   * that the listener would have to interpret.
   */
  async record(post: StarboardPost): Promise<boolean> {
    const inserted = await this.#handle.db
      .insert(starboardPosts)
      .values({
        guildId: post.guildId,
        sourceMessageId: post.sourceMessageId,
        boardMessageId: post.boardMessageId,
        starCount: post.starCount,
        createdAt: post.createdAt,
      })
      .onConflictDoNothing({
        target: [starboardPosts.guildId, starboardPosts.sourceMessageId],
      })
      .returning({ boardMessageId: starboardPosts.boardMessageId });

    return inserted.length > 0;
  }

  async setCount(guildId: string, sourceMessageId: string, starCount: number): Promise<void> {
    await this.#handle.db
      .update(starboardPosts)
      .set({ starCount })
      .where(
        and(
          eq(starboardPosts.guildId, guildId),
          eq(starboardPosts.sourceMessageId, sourceMessageId),
        ),
      );
  }

  async remove(guildId: string, sourceMessageId: string): Promise<void> {
    await this.#handle.db
      .delete(starboardPosts)
      .where(
        and(
          eq(starboardPosts.guildId, guildId),
          eq(starboardPosts.sourceMessageId, sourceMessageId),
        ),
      );
  }
}
