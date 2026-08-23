CREATE TABLE "suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"number" integer NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"thread_id" text,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestion_votes" (
	"suggestion_id" text NOT NULL,
	"user_id" text NOT NULL,
	"vote" smallint NOT NULL,
	CONSTRAINT "suggestion_votes_pk" PRIMARY KEY ("suggestion_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_votes" ADD CONSTRAINT "suggestion_votes_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_guild_number_uq" ON "suggestions" USING btree ("guild_id","number");--> statement-breakpoint
CREATE INDEX "suggestions_guild_status_idx" ON "suggestions" USING btree ("guild_id","status");
