import type { TicketPriority } from '@proton/core';

export type TicketStatus = 'open' | 'closed' | 'archived' | 'deleted';

export type TicketWaitingOn = 'staff' | 'user' | null;

export interface Ticket {
  id: string;
  guildId: string;
  number: number;
  typeId: string;
  panelId: string;
  channelId: string;

  openerId: string;
  ownerId: string;

  status: TicketStatus;
  priority: TicketPriority;
  subject: string | null;

  claimedById: string | null;
  claimedAt: Date | null;

  assignedToId: string | null;
  assignedById: string | null;
  assignedAt: Date | null;

  lockedAt: Date | null;
  lockedById: string | null;

  waitingOn: TicketWaitingOn;

  openedAt: Date;
  lastActivityAt: Date;
  lastUserMessageAt: Date | null;
  lastStaffMessageAt: Date | null;
  firstResponseAt: Date | null;

  closeRequestedById: string | null;
  closeRequestedAt: Date | null;

  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;

  archivedAt: Date | null;
  deletedAt: Date | null;

  messageCount: number;
  transcriptUrl: string | null;
}

// Which close a side effect belongs to. A reopened ticket closes again, and an idempotency key
// naming only the ticket would let the executor's dedupe swallow the second close's channel lock,
// transcript and rating prompt as replays of the first.
export function closeCycle(ticket: Ticket): string {
  return String(ticket.closedAt?.getTime() ?? 0);
}

// The same idea for the other direction: reopen() moves lastActivityAt and nothing else that is
// stable, so it is what separates one reopen from the next.
export function openCycle(ticket: Ticket): string {
  return String(ticket.lastActivityAt.getTime());
}

export interface ReserveTicketInput {
  guildId: string;
  typeId: string;
  panelId: string;
  openerId: string;
  priority: TicketPriority;
  subject?: string | undefined;
}

export interface CloseTicketInput {
  guildId: string;
  ticketId: string;
  closedBy: string;
  reason: string | null;
}

export type ParticipantKind = 'opener' | 'added';

export interface TicketParticipant {
  ticketId: string;
  userId: string;
  kind: ParticipantKind;
  addedById: string | null;
  addedAt: Date;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  guildId: string;
  type: string;
  actorId: string | null;
  data: Record<string, unknown> | null;
  at: Date;
}

export interface RecordTicketEventInput {
  ticketId: string;
  guildId: string;
  type: string;
  actorId: string | null;
  data?: Record<string, unknown> | undefined;
}

export interface TicketFormAnswer {
  fieldId: string;
  label: string;
  value: string;
  position: number;
}

export interface TicketAttachment {
  url: string;
  filename: string;
  contentType: string | null;
  size: number;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  authorBot: boolean;
  content: string;
  attachments: TicketAttachment[];
  embeds: Array<Record<string, unknown>>;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface CaptureMessageInput {
  ticketId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  authorBot: boolean;
  content: string;
  attachments: TicketAttachment[];
  embeds: Array<Record<string, unknown>>;
  replyToId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface BlacklistEntry {
  id: string;
  guildId: string;
  userId: string;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface BlacklistInput {
  guildId: string;
  userId: string;
  reason: string | null;
  createdBy: string;
  expiresAt: Date | null;
}

export interface TicketRating {
  ticketId: string;
  guildId: string;
  userId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
}

export interface TicketStats {
  opened: number;
  closed: number;
  reopened: number;
  open: number;
  averageResolutionMs: number | null;
  averageFirstResponseMs: number | null;
  averageRating: number | null;
  ratings: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  byStaff: Array<{ userId: string; claimed: number; closed: number }>;
}

export interface TicketStore {
  // Reserved before the channel exists, because the channel name carries the ticket number and the
  // number can only be allocated safely inside an insert. The row starts out pointing at its own id
  // so the live-channel unique index still holds while it waits for attach().
  reserve(input: ReserveTicketInput): Promise<Ticket>;

  attach(guildId: string, ticketId: string, channelId: string): Promise<Ticket | null>;

  abandon(guildId: string, ticketId: string): Promise<void>;

  get(guildId: string, ticketId: string): Promise<Ticket | null>;

  // Any status short of deleted, because a closed ticket keeps its channel until it is tidied up
  // and /ticket reopen has to be able to find it from inside that channel.
  byChannel(guildId: string, channelId: string): Promise<Ticket | null>;

  byNumber(guildId: string, number: number): Promise<Ticket | null>;

  countOpenFor(guildId: string, ownerId: string): Promise<number>;

  countOpenForType(guildId: string, ownerId: string, typeId: string): Promise<number>;

  countOpen(guildId: string): Promise<number>;

  // Keyed on who raised it rather than who owns it now, so handing a ticket away cannot reset the
  // opener's cooldown.
  lastOpenedAt(guildId: string, openerId: string): Promise<Date | null>;

  // Where this ticket sits among its owner's open ones, counting from one. The cap is checked
  // before the row exists, so two presses can both pass it; asking afterwards where the row landed
  // is what lets the later one stand down instead of both being kept.
  openRankAt(guildId: string, ownerId: string, number: number, typeId?: string): Promise<number>;

  listOpen(guildId: string): Promise<Ticket[]>;

  // Returns null when somebody else already made the transition, so a redelivered close is a no-op
  // rather than a second transcript and a second channel deletion. Every mutator below follows it.
  close(input: CloseTicketInput): Promise<Ticket | null>;

  reopen(guildId: string, ticketId: string, byId: string): Promise<Ticket | null>;

  archive(guildId: string, ticketId: string): Promise<Ticket | null>;

  // `expected` narrows the guard in the WHERE clause. The auto-delete job passes the closed states
  // because it read its row seconds earlier: without it, a reopen landing in that window is
  // destroyed by a job that was cancelled before it fired.
  markDeleted(
    guildId: string,
    ticketId: string,
    byId: string,
    reason: string | null,
    expected?: readonly TicketStatus[],
  ): Promise<Ticket | null>;

  claim(guildId: string, ticketId: string, userId: string): Promise<Ticket | null>;

  unclaim(guildId: string, ticketId: string): Promise<Ticket | null>;

  assign(
    guildId: string,
    ticketId: string,
    assigneeId: string | null,
    byId: string,
  ): Promise<Ticket | null>;

  transferOwner(guildId: string, ticketId: string, ownerId: string): Promise<Ticket | null>;

  setPriority(guildId: string, ticketId: string, priority: TicketPriority): Promise<Ticket | null>;

  setSubject(guildId: string, ticketId: string, subject: string | null): Promise<Ticket | null>;

  setLocked(guildId: string, ticketId: string, lockedById: string | null): Promise<Ticket | null>;

  requestClose(guildId: string, ticketId: string, byId: string): Promise<Ticket | null>;

  clearCloseRequest(guildId: string, ticketId: string): Promise<Ticket | null>;

  setTranscriptUrl(guildId: string, ticketId: string, url: string): Promise<void>;

  touch(guildId: string, channelId: string, notBefore: Date): Promise<void>;

  // Separate from touch(): the throttle that keeps a busy ticket from being the hottest write in
  // the guild must not also throttle the waiting-state flip, which is what staff actually read.
  recordActivity(
    guildId: string,
    channelId: string,
    input: { fromStaff: boolean; at: Date },
  ): Promise<Ticket | null>;

  // Rows whose timers may have come due. Bounded, because the sweep it feeds shares one global
  // budget with every other module's scheduled work.
  due(guildId: string, limit: number): Promise<Ticket[]>;

  addParticipant(
    ticketId: string,
    userId: string,
    kind: ParticipantKind,
    addedById: string | null,
  ): Promise<void>;

  removeParticipant(ticketId: string, userId: string): Promise<boolean>;

  listParticipants(ticketId: string): Promise<TicketParticipant[]>;

  recordEvent(input: RecordTicketEventInput): Promise<void>;

  listEvents(ticketId: string, limit: number): Promise<TicketEvent[]>;

  saveAnswers(ticketId: string, answers: readonly TicketFormAnswer[]): Promise<void>;

  listAnswers(ticketId: string): Promise<TicketFormAnswer[]>;

  captureMessage(input: CaptureMessageInput): Promise<void>;

  markMessageEdited(ticketId: string, messageId: string, content: string, at: Date): Promise<void>;

  markMessageDeleted(ticketId: string, messageId: string, at: Date): Promise<void>;

  listMessages(ticketId: string): Promise<TicketMessage[]>;

  purgeExpiredMessages(now: Date, limit: number): Promise<number>;

  blacklist(input: BlacklistInput): Promise<BlacklistEntry>;

  unblacklist(guildId: string, userId: string): Promise<boolean>;

  blacklistEntry(guildId: string, userId: string, now: Date): Promise<BlacklistEntry | null>;

  listBlacklist(guildId: string): Promise<BlacklistEntry[]>;

  saveRating(input: Omit<TicketRating, 'createdAt'>): Promise<boolean>;

  getRating(ticketId: string): Promise<TicketRating | null>;

  stats(guildId: string, since: Date): Promise<TicketStats>;
}
