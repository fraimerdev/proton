CREATE TABLE "member_activity_daily" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"voice_seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "member_activity_daily_pk" PRIMARY KEY("guild_id","user_id","day")
);
--> statement-breakpoint
ALTER TABLE "member_activity_daily" ADD CONSTRAINT "member_activity_daily_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_activity_daily_window_idx" ON "member_activity_daily" USING btree ("guild_id","day");
