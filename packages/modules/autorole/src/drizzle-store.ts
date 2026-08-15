import type { DbHandle } from '@proton/db';
import { members } from '@proton/db';
import { and, eq } from 'drizzle-orm';
import type { StickyRoleStore } from './store.ts';

/**
 * Sticky roles on top of §6's existing `members.sticky_roles` column.
 *
 * No new table: PLAN.md §6 declared `sticky_roles BIGINT[]` on `members` at Gate
 * 0 for exactly this, and the column has sat unused since. Storing it separately
 * would mean two rows per member with nothing keeping them in step.
 *
 * The column is `bigint[]` and role ids are 64-bit snowflakes, so they are
 * converted at this boundary and nowhere else — a role id is a string
 * everywhere above this file, because that is what Discord's API takes and what
 * `Number` would silently corrupt.
 */
export class DrizzleStickyRoleStore implements StickyRoleStore {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  async snapshot(guildId: string, userId: string, roleIds: readonly string[]): Promise<void> {
    const asBigints = roleIds.map((id) => BigInt(id));

    /**
     * Upsert, because the member row may not exist yet.
     *
     * `members` is written by leveling too, so this must touch only its own
     * column: the update sets `sticky_roles` and nothing else, and the insert
     * lets every other column take its schema default rather than asserting a
     * zeroed xp over a row that already has some.
     */
    await this.#db.db
      .insert(members)
      .values({ guildId, userId, stickyRoles: asBigints })
      .onConflictDoUpdate({
        target: [members.guildId, members.userId],
        set: { stickyRoles: asBigints },
      });
  }

  async read(guildId: string, userId: string): Promise<string[] | null> {
    const [row] = await this.#db.db
      .select({ stickyRoles: members.stickyRoles })
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.userId, userId)))
      .limit(1);

    if (!row?.stickyRoles) return null;
    return row.stickyRoles.map((id: bigint) => id.toString());
  }
}
