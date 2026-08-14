import { bigint, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const members = pgTable(
  'members',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    xp: integer('xp').notNull().default(0),
    level: integer('level').notNull().default(0),
    lastXpAt: timestamp('last_xp_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    voiceSeconds: integer('voice_seconds').notNull().default(0),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    // PLAN.md §6 specifies BIGINT[] for this column specifically. Read back in
    // string mode so 64-bit role snowflakes survive the trip through JS.
    stickyRoles: bigint('sticky_roles', { mode: 'bigint' }).array(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
