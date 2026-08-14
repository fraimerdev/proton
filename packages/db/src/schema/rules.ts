import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

/**
 * Rule-engine storage (PLAN.md P2). The table exists from Gate 0 so the data
 * model is settled early, but nothing reads or writes it until Phase 1 ships
 * preset rules — and the generic rule builder later still uses this shape.
 */
export const rules = pgTable(
  'rules',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    trigger: text('trigger').notNull(),
    conditions: jsonb('conditions').notNull().default([]),
    actions: jsonb('actions').notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    createdBy: text('created_by'),
  },
  (t) => [index('rules_guild_trigger_idx').on(t.guildId, t.trigger)],
);

export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
