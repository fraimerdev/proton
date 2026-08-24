import type { DbHandle } from '@proton/db';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { AccessKind, TempVoiceChannelRow } from './table.ts';
import { tempVoiceAccess, tempVoiceChannels, tempVoiceRoles } from './table.ts';

export type Db = DbHandle;

export interface ReserveInput {
  id: string;
  guildId: string;
  hubChannelId: string;
  ownerId: string;

  maxChannelsPerUser: number;
}

export type Reservation = { reserved: TempVoiceChannelRow } | { refused: 'at_limit'; live: number };

export interface TempVoiceRepository {
  reserve(input: ReserveInput): Promise<Reservation>;

  attach(id: string, channelId: string): Promise<void>;
  abandon(id: string): Promise<void>;

  byChannel(guildId: string, channelId: string): Promise<TempVoiceChannelRow | null>;
  byId(id: string): Promise<TempVoiceChannelRow | null>;
  ownedBy(guildId: string, ownerId: string): Promise<TempVoiceChannelRow[]>;
  liveIn(guildId: string): Promise<TempVoiceChannelRow[]>;

  setOwner(id: string, ownerId: string | null): Promise<void>;

  /** Atomic: only the first caller of a claim on an ownerless channel wins. */
  claim(id: string, ownerId: string): Promise<boolean>;

  touch(id: string): Promise<void>;

  scheduleDelete(id: string, at: Date): Promise<void>;
  cancelDelete(id: string): Promise<void>;
  due(now: Date, limit: number): Promise<TempVoiceChannelRow[]>;

  /** Marks the row closing so two sweepers cannot both delete the same Discord channel. */
  beginClose(id: string): Promise<boolean>;
  forget(id: string): Promise<void>;

  access(tempChannelId: string): Promise<Array<{ userId: string; kind: AccessKind }>>;
  setAccess(tempChannelId: string, userId: string, kind: AccessKind): Promise<void>;
  clearAccess(tempChannelId: string, userId: string): Promise<void>;

  grantedRole(tempChannelId: string, userId: string, roleId: string): Promise<void>;
  takeRole(tempChannelId: string, userId: string): Promise<string[]>;
  rolesGranted(tempChannelId: string): Promise<Array<{ userId: string; roleId: string }>>;
}

export class DrizzleTempVoiceRepository implements TempVoiceRepository {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #db() {
    return this.#handle.db;
  }

  /**
   * Written before Discord is called, not after. The old order created a real channel and then
   * recorded it, so anything that failed in between — a crash, a rate limit, a refused move —
   * leaked a channel nothing could ever find again.
   *
   * The per-user cap is enforced in the same statement that inserts, so two joins landing in the
   * same millisecond cannot both read "0 live" and both reserve.
   */
  async reserve(input: ReserveInput): Promise<Reservation> {
    const rows = await this.#db.execute<TempVoiceChannelRow>(sql`
      insert into ${tempVoiceChannels} (id, guild_id, hub_channel_id, owner_id, status)
      select ${input.id}, ${input.guildId}, ${input.hubChannelId}, ${input.ownerId}, 'reserving'
      where (
        select count(*) from ${tempVoiceChannels}
        where guild_id = ${input.guildId}
          and owner_id = ${input.ownerId}
          and status <> 'closing'
      ) < ${input.maxChannelsPerUser}
      returning *
    `);

    const reserved = rows[0];
    if (reserved) return { reserved };

    return { refused: 'at_limit', live: (await this.ownedBy(input.guildId, input.ownerId)).length };
  }

  async attach(id: string, channelId: string): Promise<void> {
    await this.#db
      .update(tempVoiceChannels)
      .set({ channelId, status: 'live', lastActiveAt: new Date() })
      .where(eq(tempVoiceChannels.id, id));
  }

  async abandon(id: string): Promise<void> {
    await this.#db.delete(tempVoiceChannels).where(eq(tempVoiceChannels.id, id));
  }

  async byChannel(guildId: string, channelId: string): Promise<TempVoiceChannelRow | null> {
    const [row] = await this.#db
      .select()
      .from(tempVoiceChannels)
      .where(
        and(eq(tempVoiceChannels.guildId, guildId), eq(tempVoiceChannels.channelId, channelId)),
      )
      .limit(1);

    return row ?? null;
  }

  async byId(id: string): Promise<TempVoiceChannelRow | null> {
    const [row] = await this.#db
      .select()
      .from(tempVoiceChannels)
      .where(eq(tempVoiceChannels.id, id))
      .limit(1);

    return row ?? null;
  }

  async ownedBy(guildId: string, ownerId: string): Promise<TempVoiceChannelRow[]> {
    return this.#db
      .select()
      .from(tempVoiceChannels)
      .where(
        and(
          eq(tempVoiceChannels.guildId, guildId),
          eq(tempVoiceChannels.ownerId, ownerId),
          eq(tempVoiceChannels.status, 'live'),
        ),
      );
  }

  async liveIn(guildId: string): Promise<TempVoiceChannelRow[]> {
    return this.#db
      .select()
      .from(tempVoiceChannels)
      .where(
        and(
          eq(tempVoiceChannels.guildId, guildId),
          inArray(tempVoiceChannels.status, ['reserving', 'live']),
        ),
      );
  }

  async setOwner(id: string, ownerId: string | null): Promise<void> {
    await this.#db
      .update(tempVoiceChannels)
      .set({ ownerId, lastActiveAt: new Date() })
      .where(eq(tempVoiceChannels.id, id));
  }

  async claim(id: string, ownerId: string): Promise<boolean> {
    // `owner_id is null` in the predicate is the whole lock: two members racing to claim the same
    // ownerless channel both run this, and Postgres lets exactly one row match.
    const rows = await this.#db.execute(sql`
      update ${tempVoiceChannels}
      set owner_id = ${ownerId}, last_active_at = now()
      where id = ${id} and owner_id is null and status = 'live'
      returning id
    `);

    return rows.length === 1;
  }

  async touch(id: string): Promise<void> {
    await this.#db
      .update(tempVoiceChannels)
      .set({ lastActiveAt: new Date() })
      .where(eq(tempVoiceChannels.id, id));
  }

  async scheduleDelete(id: string, at: Date): Promise<void> {
    await this.#db
      .update(tempVoiceChannels)
      .set({ deleteAfter: at })
      .where(eq(tempVoiceChannels.id, id));
  }

  async cancelDelete(id: string): Promise<void> {
    await this.#db
      .update(tempVoiceChannels)
      .set({ deleteAfter: null, lastActiveAt: new Date() })
      .where(eq(tempVoiceChannels.id, id));
  }

  async due(now: Date, limit: number): Promise<TempVoiceChannelRow[]> {
    return this.#db
      .select()
      .from(tempVoiceChannels)
      .where(
        and(
          isNotNull(tempVoiceChannels.deleteAfter),
          lte(tempVoiceChannels.deleteAfter, now),
          eq(tempVoiceChannels.status, 'live'),
        ),
      )
      .limit(limit);
  }

  async beginClose(id: string): Promise<boolean> {
    const rows = await this.#db.execute(sql`
      update ${tempVoiceChannels}
      set status = 'closing'
      where id = ${id} and status = 'live'
      returning id
    `);

    return rows.length === 1;
  }

  async forget(id: string): Promise<void> {
    await this.#db.delete(tempVoiceChannels).where(eq(tempVoiceChannels.id, id));
  }

  async access(tempChannelId: string): Promise<Array<{ userId: string; kind: AccessKind }>> {
    const rows = await this.#db
      .select({ userId: tempVoiceAccess.userId, kind: tempVoiceAccess.kind })
      .from(tempVoiceAccess)
      .where(eq(tempVoiceAccess.tempChannelId, tempChannelId));

    return rows.map((row) => ({ userId: row.userId, kind: row.kind as AccessKind }));
  }

  async setAccess(tempChannelId: string, userId: string, kind: AccessKind): Promise<void> {
    await this.#db
      .insert(tempVoiceAccess)
      .values({ tempChannelId, userId, kind })
      .onConflictDoUpdate({
        target: [tempVoiceAccess.tempChannelId, tempVoiceAccess.userId],
        set: { kind, grantedAt: new Date() },
      });
  }

  async clearAccess(tempChannelId: string, userId: string): Promise<void> {
    await this.#db
      .delete(tempVoiceAccess)
      .where(
        and(eq(tempVoiceAccess.tempChannelId, tempChannelId), eq(tempVoiceAccess.userId, userId)),
      );
  }

  async grantedRole(tempChannelId: string, userId: string, roleId: string): Promise<void> {
    // Proton granted it, so Proton may take it back. A role the member already had never gets a
    // row here, which is what stops cleanup stripping something they earned elsewhere.
    await this.#db
      .insert(tempVoiceRoles)
      .values({ tempChannelId, userId, roleId })
      .onConflictDoNothing();
  }

  async takeRole(tempChannelId: string, userId: string): Promise<string[]> {
    const rows = await this.#db
      .delete(tempVoiceRoles)
      .where(
        and(eq(tempVoiceRoles.tempChannelId, tempChannelId), eq(tempVoiceRoles.userId, userId)),
      )
      .returning({ roleId: tempVoiceRoles.roleId });

    return rows.map((row) => row.roleId);
  }

  async rolesGranted(tempChannelId: string): Promise<Array<{ userId: string; roleId: string }>> {
    return this.#db
      .select({ userId: tempVoiceRoles.userId, roleId: tempVoiceRoles.roleId })
      .from(tempVoiceRoles)
      .where(eq(tempVoiceRoles.tempChannelId, tempChannelId));
  }
}
