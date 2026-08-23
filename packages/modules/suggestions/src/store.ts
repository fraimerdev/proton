import type { SuggestionStatus } from './decide.ts';
import type { Tally } from './embed.ts';

export interface Suggestion {
  id: string;
  guildId: string;
  number: number;
  channelId: string;
  messageId: string | null;
  threadId: string | null;
  authorId: string;
  content: string;
  status: SuggestionStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
}

export interface CreateSuggestionInput {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
}

export interface AttachInput {
  messageId?: string;
  threadId?: string;
}

export interface DecideSuggestionInput {
  guildId: string;
  suggestionId: string;
  status: SuggestionStatus;
  decidedBy: string;
  decidedAt: Date;
  reason: string | null;
}

export type VoteValue = 1 | -1;

export type VoteOutcome = 'recorded' | 'unchanged';

export interface SuggestionStore {
  // Allocates the per-guild number inside the insert, the way cases.case_number is allocated:
  // two members running /suggest at once must not both be handed #12.
  create(input: CreateSuggestionInput): Promise<Suggestion>;

  get(guildId: string, suggestionId: string): Promise<Suggestion | null>;
  byNumber(guildId: string, number: number): Promise<Suggestion | null>;

  attach(guildId: string, suggestionId: string, ids: AttachInput): Promise<Suggestion | null>;
  remove(guildId: string, suggestionId: string): Promise<boolean>;

  decide(input: DecideSuggestionInput): Promise<Suggestion | null>;

  // One upsert on the composite key, so a member always holds exactly one vote and changing it is
  // a write rather than a second row. 'unchanged' means the same button was pressed twice.
  vote(suggestionId: string, userId: string, vote: VoteValue): Promise<VoteOutcome>;

  // Counted from the vote rows every time, never incremented: an increment drifts the moment one
  // edit fails or one event is redelivered, and nothing ever reconciles it.
  tally(suggestionId: string): Promise<Tally>;
}
