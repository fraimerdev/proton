import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const auditTrail = pgTable(
  'audit_trail',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    source: text('source').notNull(),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_trail_guild_created_idx').on(t.guildId, t.createdAt.desc())],
);

export type AuditTrailEntry = typeof auditTrail.$inferSelect;
export type NewAuditTrailEntry = typeof auditTrail.$inferInsert;
