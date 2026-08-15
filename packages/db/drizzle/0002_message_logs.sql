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
	CONSTRAINT "message_logs_pk" PRIMARY KEY ("occurred_at","id")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE INDEX "message_logs_guild_channel_occurred_idx" ON "message_logs" USING btree ("guild_id","channel_id","occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "message_logs_guild_message_idx" ON "message_logs" USING btree ("guild_id","message_id");
