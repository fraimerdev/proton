import type { DbHandle } from '@proton/db';
import { members } from '@proton/db';
import { and, eq } from 'drizzle-orm';
import type { StickyRoleStore } from './store.ts';

export class DrizzleStickyRoleStore implements StickyRoleStore {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  async snapshot(guildId: string, userId: string, roleIds: readonly string[]): Promise<void> {
    const asBigints = roleIds.map((id) => BigInt(id));

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
