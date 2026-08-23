CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"content" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_guild_user_pending_idx" ON "reminders" USING btree ("guild_id","user_id") WHERE "reminders"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("remind_at") WHERE "reminders"."delivered_at" is null;
