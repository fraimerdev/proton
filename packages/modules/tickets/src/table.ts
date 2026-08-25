import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    typeId: text('type_id').notNull(),
    panelId: text('panel_id').notNull(),
    channelId: text('channel_id').notNull(),

    openerId: text('opener_id').notNull(),
    // Separate from openerId, which never changes: a transferred ticket has to keep saying who
    // actually raised it, or the per-member open cap can be escaped by handing tickets away.
    ownerId: text('owner_id').notNull(),

    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('medium'),
    subject: text('subject'),

    claimedById: text('claimed_by_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    assignedToId: text('assigned_to_id'),
    assignedById: text('assigned_by_id'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),

    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedById: text('locked_by_id'),

    waitingOn: text('waiting_on'),

    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    lastUserMessageAt: timestamp('last_user_message_at', { withTimezone: true }),
    lastStaffMessageAt: timestamp('last_staff_message_at', { withTimezone: true }),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),

    closeRequestedById: text('close_requested_by_id'),
    closeRequestedAt: timestamp('close_requested_at', { withTimezone: true }),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    closeReason: text('close_reason'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    messageCount: integer('message_count').notNull().default(0),
    transcriptUrl: text('transcript_url'),
  },
  (t) => [
    uniqueIndex('tickets_guild_number_uq').on(t.guildId, t.number),

    // Not status = 'open' any more: a closed ticket keeps its channel until it is deleted or
    // archived, so channel exclusivity has to hold for every row that still points at a real one.
    uniqueIndex('tickets_live_channel_uq')
      .on(t.guildId, t.channelId)
      .where(sql`${t.status} <> 'deleted'`),

    index('tickets_guild_opener_open_idx')
      .on(t.guildId, t.openerId)
      .where(sql`${t.status} = 'open'`),

    index('tickets_guild_status_idx').on(t.guildId, t.status),
    index('tickets_guild_type_idx').on(t.guildId, t.typeId),
    index('tickets_guild_panel_idx').on(t.guildId, t.panelId),
    index('tickets_guild_owner_idx').on(t.guildId, t.ownerId),
    index('tickets_guild_claimed_idx').on(t.guildId, t.claimedById),
    index('tickets_guild_opened_idx').on(t.guildId, t.openedAt),
    index('tickets_guild_closed_idx').on(t.guildId, t.closedAt),

    // The patrol reads this one every sweep, so it stays narrow: only rows that can still change.
    index('tickets_activity_idx')
      .on(t.lastActivityAt)
      .where(sql`${t.status} in ('open', 'closed')`),
  ],
);

export const ticketParticipants = pgTable(
  'ticket_participants',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull().default('added'),
    addedById: text('added_by_id'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ticket_participants_uq').on(t.ticketId, t.userId),
    index('ticket_participants_user_idx').on(t.userId),
  ],
);

export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    guildId: text('guild_id').notNull(),
    type: text('type').notNull(),
    actorId: text('actor_id'),
    data: jsonb('data'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ticket_events_ticket_idx').on(t.ticketId, t.at),
    index('ticket_events_guild_type_idx').on(t.guildId, t.type),
    index('ticket_events_actor_idx').on(t.guildId, t.actorId),
  ],
);

export const ticketFormAnswers = pgTable(
  'ticket_form_answers',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    fieldId: text('field_id').notNull(),
    label: text('label').notNull(),
    value: text('value').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('ticket_form_answers_uq').on(t.ticketId, t.fieldId)],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    authorId: text('author_id').notNull(),
    authorName: text('author_name').notNull(),
    authorBot: boolean('author_bot').notNull().default(false),
    content: text('content').notNull().default(''),
    attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),
    embeds: jsonb('embeds').notNull().default(sql`'[]'::jsonb`),
    replyToId: text('reply_to_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Written on insert rather than derived on read: the sweep that drops expired transcript text
    // must not have to re-read the guild's config to know when a row was due to go.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('ticket_messages_uq').on(t.ticketId, t.messageId),
    index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt),
    index('ticket_messages_expiry_idx').on(t.expiresAt),
  ],
);

export const ticketBlacklist = pgTable(
  'ticket_blacklist',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    reason: text('reason'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('ticket_blacklist_uq').on(t.guildId, t.userId),
    index('ticket_blacklist_expiry_idx').on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
  ],
);

export const ticketRatings = pgTable(
  'ticket_ratings',
  {
    ticketId: text('ticket_id')
      .primaryKey()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    rating: integer('rating').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ticket_ratings_guild_idx').on(t.guildId, t.createdAt)],
);

export type TicketRow = typeof tickets.$inferSelect;
export type NewTicketRow = typeof tickets.$inferInsert;
export type TicketParticipantRow = typeof ticketParticipants.$inferSelect;
export type TicketEventRow = typeof ticketEvents.$inferSelect;
export type TicketFormAnswerRow = typeof ticketFormAnswers.$inferSelect;
export type TicketMessageRow = typeof ticketMessages.$inferSelect;
export type TicketBlacklistRow = typeof ticketBlacklist.$inferSelect;
export type TicketRatingRow = typeof ticketRatings.$inferSelect;
