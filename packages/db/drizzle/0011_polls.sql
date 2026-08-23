CREATE TABLE "polls" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"created_by" text NOT NULL,
	"question" text NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"announce_channel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polls_pk" PRIMARY KEY ("guild_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "polls_guild_running_idx" ON "polls" USING btree ("guild_id") WHERE "polls"."ended_at" is null;
