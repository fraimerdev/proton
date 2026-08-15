-- Starboard posts (PLAN.md §8 Phase 3; docs/PHASE-3.md G7).
--
-- Hand-written, and in the core migration set rather than in the module that
-- owns it, for the reason `0002_message_logs.sql` records: §7 gives a manifest
-- its own `migrations` array and **nothing runs it**. `logging` shipped its DDL
-- here as a workaround; this is the second table to take that route, which
-- PHASE-3.md G7/R5 names as debt to close or own rather than repeat silently.
--
-- The Drizzle object that mirrors this file lives in
-- packages/modules/starboard/src/table.ts and is deliberately NOT exported from
-- packages/db/src/schema: the barrel is what `drizzle-kit generate` diffs
-- against, so a table it can see is a table it emits its own CREATE for — a
-- third copy of this DDL, owned by nobody. The module's integration test reads
-- back what it writes, so the two cannot drift silently.
CREATE TABLE "starboard_posts" (
	"guild_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"board_message_id" text NOT NULL,
	"star_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- (guild_id, source_message_id), because the question asked on every reaction
	-- is "have I already posted *this message*". `board_message_id` is the answer,
	-- not the key. The primary key is also what makes the insert's ON CONFLICT DO
	-- NOTHING an effective dedupe when two reactions race to create the same post
	-- (I4) — see `create` in the module's listener.
	CONSTRAINT "starboard_posts_pk" PRIMARY KEY ("guild_id","source_message_id")
);
--> statement-breakpoint
-- Cascade, matching every other per-guild table: when the bot is removed and the
-- guild row goes, so do its board posts. The rows are small and bounded by the
-- number of starred messages, so this is an ordinary delete rather than the
-- unbounded sweep that kept `message_logs` out of the same relationship.
ALTER TABLE "starboard_posts" ADD CONSTRAINT "starboard_posts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
