import type { EventType, RuleAction, RuleCondition, RuleTrigger } from '@proton/core';
import { sql } from 'drizzle-orm';
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
    /**
     * The whole `RuleTrigger` union, verbatim. It was `text` until 0003, which
     * could hold the event variant's discriminator and nothing else — a cron
     * trigger carries a `cron` expression and an optional `timezone`, so storing
     * it in a text column meant either losing those fields or inventing an
     * encoding that `ruleTriggerSchema` does not describe.
     */
    trigger: jsonb('trigger').$type<RuleTrigger>().notNull(),
    /**
     * The event an event-triggered rule listens for; NULL for a cron rule.
     * Derived by Postgres, never written — see `rules_guild_trigger_event_idx`.
     *
     * A plain second column holding the same fact would be the other way to keep
     * the lookup cheap, but then two columns state one thing and every writer is
     * responsible for keeping them equal. GENERATED ALWAYS makes the drift
     * unrepresentable: there is one source of truth and Postgres derives the rest.
     *
     * The `kind` guard is not redundant with `->> 'event'` alone. Nothing in the
     * database stops a writer that skips `ruleTriggerSchema` from storing a cron
     * trigger that also carries an `event` key, and an unguarded expression would
     * quietly enrol that row in event dispatch — a cron rule firing on every
     * message. Guarded, the column means exactly "the event this rule fires on".
     */
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
  /**
   * "Load this guild's rules for event X" — the query the worker runs on every
   * dispatch — stays a single index probe. Cron rules sort into the NULLs and so
   * are never candidates for an event, which is the correct answer for them.
   */
  (t) => [index('rules_guild_trigger_event_idx').on(t.guildId, t.triggerEvent)],
);

export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
