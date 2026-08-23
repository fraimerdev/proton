export type TicketStatus = 'open' | 'closed';

export interface Ticket {
  id: string;
  guildId: string;
  number: number;
  panelId: string;
  channelId: string;
  openerId: string;
  status: TicketStatus;
  openedAt: Date;
  lastActivityAt: Date;
  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;
}

export interface ReserveTicketInput {
  guildId: string;
  panelId: string;
  openerId: string;
}

export interface CloseTicketInput {
  guildId: string;
  ticketId: string;
  closedBy: string;
  reason: string | null;
}

export interface TicketStore {
  // Reserved before the channel exists, because the channel name carries the ticket number and
  // the number can only be allocated safely inside an insert. The row starts out pointing at its
  // own id so the open-channel unique index still holds while it waits for attach().
  reserve(input: ReserveTicketInput): Promise<Ticket>;

  attach(guildId: string, ticketId: string, channelId: string): Promise<Ticket | null>;

  abandon(guildId: string, ticketId: string): Promise<void>;

  get(guildId: string, ticketId: string): Promise<Ticket | null>;

  byChannel(guildId: string, channelId: string): Promise<Ticket | null>;

  // Any status, unlike byChannel: a close that died after the row flipped leaves a closed row whose
  // channel is still there, and looking it up by number is the only way back to it.
  byNumber(guildId: string, number: number): Promise<Ticket | null>;

  countOpenFor(guildId: string, openerId: string): Promise<number>;

  listOpen(guildId: string): Promise<Ticket[]>;

  // Returns null when it was already closed, so a redelivered close is a no-op rather than a
  // second transcript and a second channel deletion.
  close(input: CloseTicketInput): Promise<Ticket | null>;

  touch(guildId: string, channelId: string, notBefore: Date): Promise<void>;
}
