import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const appeals = pgTable(
  'appeals',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),

    number: integer('number').notNull(),

    userId: text('user_id').notNull(),
    panelId: text('panel_id').notNull(),

    // Which module minted the link, and the id it minted it under. Together they are what makes
    // re-opening the same link find the appeal already filed rather than file a second one.
    origin: text('origin').notNull(),
    jti: text('jti').notNull(),

    status: text('status').notNull().default('open'),

    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),

    // Whether the unban (or untimeout) that an approval owes has actually been carried out. A
    // decision recorded but not applied is what a moderator pressing the button again repairs.
    outcomeApplied: boolean('outcome_applied').notNull().default(false),

    cardChannelId: text('card_channel_id'),
    cardMessageId: text('card_message_id'),

    dmChannelId: text('dm_channel_id'),
    dmAttempts: integer('dm_attempts').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('appeals_guild_number_uq').on(t.guildId, t.number),

    // The link is the identity. Opening it twice must find the same appeal, not file a second.
    uniqueIndex('appeals_origin_jti_uq').on(t.guildId, t.origin, t.jti),

    uniqueIndex('appeals_one_open_uq').on(t.guildId, t.userId).where(sql`${t.status} = 'open'`),

    index('appeals_guild_created_idx').on(t.guildId, t.createdAt.desc()),
  ],
);

export type AppealRow = typeof appeals.$inferSelect;
export type NewAppealRow = typeof appeals.$inferInsert;

export const appealAnswers = pgTable(
  'appeal_answers',
  {
    id: text('id').primaryKey(),
    appealId: text('appeal_id')
      .notNull()
      .references(() => appeals.id, { onDelete: 'cascade' }),

    position: integer('position').notNull(),

    questionKey: text('question_key').notNull(),
    label: text('label').notNull(),
    value: text('value').notNull(),
  },
  (t) => [index('appeal_answers_appeal_idx').on(t.appealId, t.position)],
);

export type AppealAnswerRow = typeof appealAnswers.$inferSelect;
