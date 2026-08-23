import type { DbHandle } from '@proton/db';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { CreateTagInput, ListTagsQuery, ListTagsResult, Tag, TagStore } from './store.ts';
import { type TagRow, tags } from './table.ts';

function toTag(row: TagRow): Tag {
  return {
    guildId: row.guildId,
    name: row.name,
    content: row.content,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    uses: row.uses,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class DrizzleTagStore implements TagStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async get(guildId: string, name: string): Promise<Tag | null> {
    const rows = await this.#handle.db
      .select()
      .from(tags)
      .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
      .limit(1);

    const row = rows[0];
    return row ? toTag(row) : null;
  }

  async recall(guildId: string, name: string): Promise<Tag | null> {
    const rows = await this.#handle.db
      .update(tags)
      .set({ uses: sql`${tags.uses} + 1` })
      .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
      .returning();

    const row = rows[0];
    return row ? toTag(row) : null;
  }

  async create(input: CreateTagInput): Promise<'created' | 'exists'> {
    const inserted = await this.#handle.db
      .insert(tags)
      .values({
        guildId: input.guildId,
        name: input.name,
        content: input.content,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing({ target: [tags.guildId, tags.name] })
      .returning({ name: tags.name });

    return inserted.length > 0 ? 'created' : 'exists';
  }

  async update(guildId: string, name: string, content: string, editedBy: string): Promise<boolean> {
    const updated = await this.#handle.db
      .update(tags)
      .set({ content, updatedBy: editedBy, updatedAt: new Date() })
      .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
      .returning({ name: tags.name });

    return updated.length > 0;
  }

  async remove(guildId: string, name: string): Promise<boolean> {
    const removed = await this.#handle.db
      .delete(tags)
      .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
      .returning({ name: tags.name });

    return removed.length > 0;
  }

  async list(query: ListTagsQuery): Promise<ListTagsResult> {
    const [rows, totals] = await Promise.all([
      this.#handle.db
        .select()
        .from(tags)
        .where(eq(tags.guildId, query.guildId))
        .orderBy(asc(tags.name))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#handle.db.select({ value: count() }).from(tags).where(eq(tags.guildId, query.guildId)),
    ]);

    return { tags: rows.map(toTag), total: totals[0]?.value ?? 0 };
  }

  async count(guildId: string): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(tags)
      .where(eq(tags.guildId, guildId));

    return rows[0]?.value ?? 0;
  }

  async suggest(guildId: string, prefix: string, limit: number): Promise<string[]> {
    const rows = await this.#handle.db
      .select({ name: tags.name })
      .from(tags)
      .where(
        prefix.length === 0
          ? eq(tags.guildId, guildId)
          : and(
              eq(tags.guildId, guildId),
              sql`${tags.name} like ${`${escapeLike(prefix)}%`} escape '\\'`,
            ),
      )
      .orderBy(asc(tags.name))
      .limit(limit);

    return rows.map((row) => row.name);
  }
}
