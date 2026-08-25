import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

const base = {
  guildId: snowflakeSchema,
  ticketId: z.string().min(1).max(64),
  number: z.number().int().min(1),
  channelId: snowflakeSchema,
  typeId: z.string().min(1).max(64),
  typeName: z.string().min(1).max(100),
};

export const ticketOpenedEventSchema = z.object({
  ...base,
  openerId: snowflakeSchema,
  priority: z.enum(TICKET_PRIORITIES),
  subject: z.string().max(200).optional(),
});

export const ticketClaimedEventSchema = z.object({
  ...base,
  claimedById: snowflakeSchema,
});

export const ticketClosedEventSchema = z.object({
  ...base,
  openerId: snowflakeSchema,
  closedById: snowflakeSchema,
  reason: z.string().max(512).nullable(),
  openedAt: z.number().int(),
  closedAt: z.number().int(),
  messageCount: z.number().int().min(0),
  transcriptUrl: z.string().max(2000).optional(),
});

export const ticketReopenedEventSchema = z.object({
  ...base,
  reopenedById: snowflakeSchema,
});

export const ticketDeletedEventSchema = z.object({
  ...base,
  deletedById: snowflakeSchema,
  reason: z.string().max(512).nullable(),
});

export type TicketOpenedEvent = z.infer<typeof ticketOpenedEventSchema>;
export type TicketClaimedEvent = z.infer<typeof ticketClaimedEventSchema>;
export type TicketClosedEvent = z.infer<typeof ticketClosedEventSchema>;
export type TicketReopenedEvent = z.infer<typeof ticketReopenedEventSchema>;
export type TicketDeletedEvent = z.infer<typeof ticketDeletedEventSchema>;
