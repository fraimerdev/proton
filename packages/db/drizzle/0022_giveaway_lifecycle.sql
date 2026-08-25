ALTER TABLE "giveaways" ADD COLUMN "short_code" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "paused_by" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "paused_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "entry_method" text DEFAULT 'button' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "left_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "giveaways_short_code_uq" ON "giveaways" ("guild_id","short_code") WHERE "short_code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_status_ck" CHECK ("status" IN ('scheduled','running','paused','drawing','ended','cancelled'));--> statement-breakpoint
DROP INDEX IF EXISTS "giveaway_entries_live_idx";--> statement-breakpoint
CREATE INDEX "giveaway_entries_live_idx" ON "giveaway_entries" ("giveaway_id","user_id") WHERE "disqualified_at" IS NULL AND "left_at" IS NULL;
