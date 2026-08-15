-- Message logs (PLAN.md §6): "Message logs never go in these tables:
-- daily-partitioned Postgres table with TTL job in v1; per-guild opt-in".
--
-- Hand-written rather than generated. drizzle-kit has no way to express
-- PARTITION BY, so a generated migration would produce an ordinary table that
-- looks identical until the first retention sweep, when expiring 30 days of
-- message content becomes a DELETE over the whole table instead of a DROP of
-- one partition. The partitioning *is* the retention mechanism, so it cannot be
-- a detail the schema tool is allowed to lose.
--
-- The Drizzle table object that mirrors this file lives in
-- packages/modules/logging/src/table.ts and is deliberately NOT exported from
-- packages/db/src/schema — if drizzle-kit could see it, the next `generate`
-- would emit a CREATE TABLE that drops the partitioning.
--
-- Partitions themselves are created at runtime by the logging module's
-- maintenance job, one per UTC day, plus one day of lookahead.
CREATE TABLE "message_logs" (
	"id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"author_id" text,
	"kind" text NOT NULL,
	"content_before" text,
	"content_after" text,
	"occurred_at" timestamp with time zone NOT NULL,
	-- Postgres requires the partition key in every unique constraint, so the key
	-- is (occurred_at, id) rather than id alone. `id` is the originating event id,
	-- which the gateway derives deterministically from the dispatch — that is what
	-- makes ON CONFLICT DO NOTHING an effective dedupe for a redelivered event (I4).
	CONSTRAINT "message_logs_pk" PRIMARY KEY ("occurred_at","id")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
-- Indexes on the partitioned parent are inherited by every partition, including
-- ones created later, so the maintenance job never has to know about them.
--
-- No foreign key to `guilds`. A cascade from a guild row would turn "the bot was
-- removed" into an unbounded row-by-row delete across every live partition —
-- exactly the cost the partitioning exists to avoid. Purging one guild's logs on
-- removal is a targeted job, not a constraint.
CREATE INDEX "message_logs_guild_channel_occurred_idx" ON "message_logs" USING btree ("guild_id","channel_id","occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "message_logs_guild_message_idx" ON "message_logs" USING btree ("guild_id","message_id");
