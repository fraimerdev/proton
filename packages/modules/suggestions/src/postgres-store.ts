import type { DbHandle } from '@proton/db';
import { and, eq, sql } from 'drizzle-orm';
import type { SuggestionStatus } from './decide.ts';
import type { Tally } from './embed.ts';
import type {
  AttachInput,
  CreateSuggestionInput,
  DecideSuggestionInput,
  Suggestion,
  SuggestionStore,
  VoteOutcome,
  VoteValue,
} from './store.ts';
import { type SuggestionRow, suggestions, suggestionVotes } from './table.ts';

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    channelId: row.channelId,
    messageId: row.messageId,
    threadId: row.threadId,
    authorId: row.authorId,
    content: row.content,
    status: row.status as SuggestionStatus,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
  };
}

export class DrizzleSuggestionStore implements SuggestionStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async create(input: CreateSuggestionInput): Promise<Suggestion> {
    const rows = await this.#handle.db
      .insert(suggestions)
      .values({
        id: input.id,
        guildId: input.guildId,
        number: sql<number>`(select coalesce(max(${suggestions.number}), 0) + 1 from ${suggestions} where ${suggestions.guildId} = ${input.guildId})`,
        channelId: input.channelId,
        authorId: input.authorId,
        content: input.content,
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(
        `the suggestion row for '${input.id}' was not written back by Postgres, so the ` +
          'suggestion has no number and cannot be posted. Nothing was sent to Discord.',
      );
    }

    return toSuggestion(row);
  }

  async get(guildId: string, suggestionId: string): Promise<Suggestion | null> {
    const rows = await this.#handle.db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, suggestionId)))
      .limit(1);

    const row = rows[0];
    return row ? toSuggestion(row) : null;
  }

  async byNumber(guildId: string, number: number): Promise<Suggestion | null> {
    const rows = await this.#handle.db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.number, number)))
      .limit(1);

    const row = rows[0];
    return row ? toSuggestion(row) : null;
  }

  async attach(
    guildId: string,
    suggestionId: string,
    ids: AttachInput,
  ): Promise<Suggestion | null> {
    const rows = await this.#handle.db
      .update(suggestions)
      .set({
        ...(ids.messageId === undefined ? {} : { messageId: ids.messageId }),
        ...(ids.threadId === undefined ? {} : { threadId: ids.threadId }),
      })
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, suggestionId)))
      .returning();

    const row = rows[0];
    return row ? toSuggestion(row) : null;
  }

  async remove(guildId: string, suggestionId: string): Promise<boolean> {
    const removed = await this.#handle.db
      .delete(suggestions)
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, suggestionId)))
      .returning({ id: suggestions.id });

    return removed.length > 0;
  }

  async decide(input: DecideSuggestionInput): Promise<Suggestion | null> {
    const rows = await this.#handle.db
      .update(suggestions)
      .set({
        status: input.status,
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt,
        decisionReason: input.reason,
      })
      .where(and(eq(suggestions.guildId, input.guildId), eq(suggestions.id, input.suggestionId)))
      .returning();

    const row = rows[0];
    return row ? toSuggestion(row) : null;
  }

  async vote(suggestionId: string, userId: string, vote: VoteValue): Promise<VoteOutcome> {
    const written = await this.#handle.db
      .insert(suggestionVotes)
      .values({ suggestionId, userId, vote })
      .onConflictDoUpdate({
        target: [suggestionVotes.suggestionId, suggestionVotes.userId],
        set: { vote },
        // Without the guard an upsert always reports a write, so pressing the same button twice
        // would read as a fresh vote instead of "nothing changed".
        setWhere: sql`${suggestionVotes.vote} is distinct from excluded.vote`,
      })
      .returning({ userId: suggestionVotes.userId });

    return written.length > 0 ? 'recorded' : 'unchanged';
  }

  async tally(suggestionId: string): Promise<Tally> {
    const rows = await this.#handle.db
      .select({
        up: sql<number>`count(*) filter (where ${suggestionVotes.vote} = 1)`.mapWith(Number),
        down: sql<number>`count(*) filter (where ${suggestionVotes.vote} = -1)`.mapWith(Number),
      })
      .from(suggestionVotes)
      .where(eq(suggestionVotes.suggestionId, suggestionId));

    return { up: rows[0]?.up ?? 0, down: rows[0]?.down ?? 0 };
  }
}
