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

export const ticketSourceSchema = z.object({
  module: z.string().min(1).max(40),
  ref: z.string().min(1).max(100),
});

export const ticketOpenedEventSchema = z.object({
  ...base,
  openerId: snowflakeSchema,
  priority: z.enum(TICKET_PRIORITIES),
  subject: z.string().max(200).optional(),
  source: ticketSourceSchema.optional(),
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
  source: ticketSourceSchema.optional(),
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

export const ticketOpenRequestedSchema = z.object({
  guildId: snowflakeSchema,
  requestId: z.string().min(1).max(200),
  sourceModule: z.string().min(1).max(40),
  sourceRef: z.string().min(1).max(100),
  typeId: z.string().min(1).max(64),
  ownerId: snowflakeSchema,
  requestedById: snowflakeSchema,
  subject: z.string().max(200).optional(),
  context: z
    .array(z.object({ label: z.string().min(1).max(45), value: z.string().min(1).max(1024) }))
    .max(5)
    .default([]),
  participantIds: z.array(snowflakeSchema).max(10).default([]),
});

export const TICKET_OPEN_OUTCOMES = ['opened', 'reused', 'reopened', 'refused'] as const;

export type TicketOpenOutcome = (typeof TICKET_OPEN_OUTCOMES)[number];

export const ticketOpenAnsweredSchema = z.object({
  guildId: snowflakeSchema,
  requestId: z.string().min(1).max(200),
  sourceModule: z.string().min(1).max(40),
  sourceRef: z.string().min(1).max(100),
  status: z.enum(TICKET_OPEN_OUTCOMES),
  ticketId: z.string().max(64).optional(),
  number: z.number().int().optional(),
  channelId: snowflakeSchema.optional(),
  reason: z.string().max(300).optional(),
});

export type TicketSource = z.infer<typeof ticketSourceSchema>;
export type TicketOpenedEvent = z.infer<typeof ticketOpenedEventSchema>;
export type TicketClaimedEvent = z.infer<typeof ticketClaimedEventSchema>;
export type TicketClosedEvent = z.infer<typeof ticketClosedEventSchema>;
export type TicketReopenedEvent = z.infer<typeof ticketReopenedEventSchema>;
export type TicketDeletedEvent = z.infer<typeof ticketDeletedEventSchema>;
export type TicketOpenRequested = z.infer<typeof ticketOpenRequestedSchema>;
export type TicketOpenAnswered = z.infer<typeof ticketOpenAnsweredSchema>;
