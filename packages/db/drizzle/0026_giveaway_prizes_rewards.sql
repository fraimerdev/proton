ALTER TABLE "giveaways" ADD COLUMN "prizes" jsonb;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "reward_role_id" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "recurrence_config" jsonb;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "recurrence_left" integer;--> statement-breakpoint
CREATE INDEX "giveaways_recurring_idx" ON "giveaways" ("guild_id") WHERE "recurrence_config" IS NOT NULL;
