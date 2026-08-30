CREATE TABLE "appeals" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"number" integer NOT NULL,
	"user_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"origin" text NOT NULL,
	"jti" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"outcome_applied" boolean DEFAULT false NOT NULL,
	"card_channel_id" text,
	"card_message_id" text,
	"dm_channel_id" text,
	"dm_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appeal_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"appeal_id" text NOT NULL,
	"position" integer NOT NULL,
	"question_key" text NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal_answers" ADD CONSTRAINT "appeal_answers_appeal_id_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_guild_number_uq" ON "appeals" USING btree ("guild_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_origin_jti_uq" ON "appeals" USING btree ("guild_id","origin","jti");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_one_open_uq" ON "appeals" USING btree ("guild_id","user_id") WHERE "appeals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "appeals_guild_created_idx" ON "appeals" USING btree ("guild_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "appeal_answers_appeal_idx" ON "appeal_answers" USING btree ("appeal_id","position");
