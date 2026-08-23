import type { DbHandle } from '@proton/db';
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import type { CreatePollInput, PollRecord, PollStore } from './store.ts';
import { type PollRow, polls } from './table.ts';

function toRecord(row: PollRow): PollRecord {
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    createdBy: row.createdBy,
    question: row.question,
    endsAt: row.endsAt,
    endedAt: row.endedAt,
    announceChannelId: row.announceChannelId,
    createdAt: row.createdAt,
  };
}

export class DrizzlePollStore implements PollStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async create(input: CreatePollInput): Promise<void> {
    await this.#handle.db
      .insert(polls)
      .values({
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        createdBy: input.createdBy,
        question: input.question,
        endsAt: input.endsAt,
        announceChannelId: input.announceChannelId,
      })
      .onConflictDoNothing({ target: [polls.guildId, polls.messageId] });
  }

  async get(guildId: string, messageId: string): Promise<PollRecord | null> {
    const rows = await this.#handle.db
      .select()
      .from(polls)
      .where(and(eq(polls.guildId, guildId), eq(polls.messageId, messageId)))
      .limit(1);

    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listRunning(guildId: string): Promise<PollRecord[]> {
    const rows = await this.#handle.db
      .select()
      .from(polls)
      .where(and(eq(polls.guildId, guildId), isNull(polls.endedAt)))
      .orderBy(asc(polls.endsAt));

    return rows.map(toRecord);
  }

  async countRunning(guildId: string, now: Date): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(polls)
      .where(and(eq(polls.guildId, guildId), isNull(polls.endedAt), gt(polls.endsAt, now)));

    return rows[0]?.value ?? 0;
  }

  async end(guildId: string, messageId: string, endedAt: Date): Promise<boolean> {
    const ended = await this.#handle.db
      .update(polls)
      .set({ endedAt })
      .where(and(eq(polls.guildId, guildId), eq(polls.messageId, messageId), isNull(polls.endedAt)))
      .returning({ messageId: polls.messageId });

    return ended.length > 0;
  }
}
