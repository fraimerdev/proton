import type { DbHandle } from '@proton/db';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { CreateReminderInput, PendingQuery, Reminder, ReminderStore } from './store.ts';
import { type ReminderRow, reminders } from './table.ts';

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    channelId: row.channelId,
    content: row.content,
    remindAt: row.remindAt,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class DrizzleReminderStore implements ReminderStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async create(input: CreateReminderInput): Promise<Reminder | null> {
    const rows = await this.#handle.db
      .insert(reminders)
      .values({
        id: input.id,
        guildId: input.guildId,
        userId: input.userId,
        channelId: input.channelId,
        content: input.content,
        remindAt: input.remindAt,
      })
      .onConflictDoNothing({ target: reminders.id })
      .returning();

    const row = rows[0];
    return row ? toReminder(row) : null;
  }

  async get(guildId: string, id: string): Promise<Reminder | null> {
    const rows = await this.#handle.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.guildId, guildId), eq(reminders.id, id)))
      .limit(1);

    const row = rows[0];
    return row ? toReminder(row) : null;
  }

  async pending(query: PendingQuery): Promise<Reminder[]> {
    const search = query.search?.trim() ?? '';

    const rows = await this.#handle.db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.guildId, query.guildId),
          eq(reminders.userId, query.userId),
          isNull(reminders.deliveredAt),
          ...(search.length === 0
            ? []
            : [sql`${reminders.content} ilike ${`%${escapeLike(search)}%`} escape '\\'`]),
        ),
      )
      .orderBy(asc(reminders.remindAt))
      .limit(query.limit);

    return rows.map(toReminder);
  }

  async countPending(guildId: string, userId: string): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(reminders)
      .where(
        and(
          eq(reminders.guildId, guildId),
          eq(reminders.userId, userId),
          isNull(reminders.deliveredAt),
        ),
      );

    return rows[0]?.value ?? 0;
  }

  async remove(guildId: string, id: string, userId: string): Promise<boolean> {
    const removed = await this.#handle.db
      .delete(reminders)
      .where(
        and(eq(reminders.guildId, guildId), eq(reminders.id, id), eq(reminders.userId, userId)),
      )
      .returning({ id: reminders.id });

    return removed.length > 0;
  }

  async markDelivered(guildId: string, id: string, deliveredAt: Date): Promise<boolean> {
    const updated = await this.#handle.db
      .update(reminders)
      .set({ deliveredAt })
      .where(
        and(eq(reminders.guildId, guildId), eq(reminders.id, id), isNull(reminders.deliveredAt)),
      )
      .returning({ id: reminders.id });

    return updated.length > 0;
  }
}
