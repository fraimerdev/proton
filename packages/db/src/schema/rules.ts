import type { EventType, RuleAction, RuleCondition, RuleTrigger } from '@proton/core';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const rules = pgTable(
  'rules',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),

    trigger: jsonb('trigger').$type<RuleTrigger>().notNull(),

    triggerEvent: text('trigger_event')
      .$type<EventType>()
      .generatedAlwaysAs(
        sql`case when "trigger" ->> 'kind' = 'event' then "trigger" ->> 'event' end`,
      ),
    conditions: jsonb('conditions').$type<RuleCondition[]>().notNull().default([]),
    actions: jsonb('actions').$type<RuleAction[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    createdBy: text('created_by'),
  },

  (t) => [index('rules_guild_trigger_event_idx').on(t.guildId, t.triggerEvent)],
);

export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
