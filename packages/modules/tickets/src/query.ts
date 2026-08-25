import { snowflakeSchema, TICKET_PRIORITIES } from '@proton/core';
import { z } from 'zod';
import { TICKET_STATUSES, TYPE_ID_MAX } from './config.ts';
import type { Ticket } from './store.ts';

export const TICKET_PAGE_SIZE_DEFAULT = 25;
export const TICKET_PAGE_SIZE_MAX = 100;

export const TICKET_SORT_FIELDS = ['number', 'openedAt', 'closedAt'] as const;
export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number];

export const TICKET_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type TicketSortDirection = (typeof TICKET_SORT_DIRECTIONS)[number];

export const TICKET_STATS_DAYS_DEFAULT = 30;
export const TICKET_STATS_DAYS_MAX = 365;

export const ticketQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(TICKET_PAGE_SIZE_MAX)
    .default(TICKET_PAGE_SIZE_DEFAULT),

  search: z.string().max(100).optional(),

  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  typeId: z.string().max(TYPE_ID_MAX).optional(),
  ownerId: snowflakeSchema.optional(),

  sort: z.enum(TICKET_SORT_FIELDS).default('number'),
  direction: z.enum(TICKET_SORT_DIRECTIONS).default('desc'),
});

export type TicketQueryInput = z.input<typeof ticketQuerySchema>;
export type TicketQuery = z.output<typeof ticketQuerySchema>;

export const ticketStatsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(TICKET_STATS_DAYS_MAX)
    .default(TICKET_STATS_DAYS_DEFAULT),
});

export type TicketStatsQuery = z.output<typeof ticketStatsQuerySchema>;

export interface TicketSummary {
  id: string;
  number: number;
  typeId: string;
  panelId: string;
  channelId: string;
  status: Ticket['status'];
  priority: Ticket['priority'];
  subject: string | null;
  openerId: string;
  ownerId: string;
  claimedById: string | null;
  assignedToId: string | null;
  closedBy: string | null;
  closeReason: string | null;
  messageCount: number;
  transcriptUrl: string | null;
  openedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
}

export type TicketRecord = Omit<TicketSummary, 'openedAt' | 'lastActivityAt' | 'closedAt'> &
  Pick<Ticket, 'openedAt' | 'lastActivityAt' | 'closedAt'>;

export interface TicketSearchResult {
  tickets: TicketSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export function toSummary(ticket: TicketRecord): TicketSummary {
  return {
    id: ticket.id,
    number: ticket.number,
    typeId: ticket.typeId,
    panelId: ticket.panelId,
    channelId: ticket.channelId,
    status: ticket.status,
    priority: ticket.priority,
    subject: ticket.subject,
    openerId: ticket.openerId,
    ownerId: ticket.ownerId,
    claimedById: ticket.claimedById,
    assignedToId: ticket.assignedToId,
    closedBy: ticket.closedBy,
    closeReason: ticket.closeReason,
    messageCount: ticket.messageCount,
    transcriptUrl: ticket.transcriptUrl,
    openedAt: ticket.openedAt.toISOString(),
    lastActivityAt: ticket.lastActivityAt.toISOString(),
    closedAt: ticket.closedAt?.toISOString() ?? null,
  };
}
