DROP INDEX IF EXISTS "giveaways_guild_running_idx";--> statement-breakpoint
CREATE INDEX "giveaways_guild_status_idx" ON "giveaways" ("guild_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "giveaways_message_idx" ON "giveaways" ("guild_id","message_id") WHERE "message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "giveaways_drawing_idx" ON "giveaways" ("drawing_started_at") WHERE "status" = 'drawing';--> statement-breakpoint
CREATE INDEX "giveaways_scheduled_idx" ON "giveaways" ("starts_at") WHERE "status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "giveaway_entries_member_idx" ON "giveaway_entries" ("user_id","joined_at");--> statement-breakpoint
CREATE INDEX "giveaway_wins_member_idx" ON "giveaway_wins" ("user_id");--> statement-breakpoint
CREATE INDEX "giveaway_wins_claim_idx" ON "giveaway_wins" ("claim_deadline") WHERE "claimed_at" IS NULL AND "forfeited_at" IS NULL;
