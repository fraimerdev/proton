ALTER TABLE "tickets" ADD COLUMN "type_id" text;--> statement-breakpoint
UPDATE "tickets" SET "type_id" = "panel_id" WHERE "type_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "owner_id" text;--> statement-breakpoint
UPDATE "tickets" SET "owner_id" = "opener_id" WHERE "owner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "claimed_by_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assigned_to_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assigned_by_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "locked_by_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "waiting_on" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_user_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_staff_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "first_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "close_requested_by_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "close_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "transcript_url" text;--> statement-breakpoint
DROP INDEX IF EXISTS "tickets_open_channel_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_live_channel_uq" ON "tickets" USING btree ("guild_id","channel_id") WHERE "tickets"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "tickets_guild_status_idx" ON "tickets" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "tickets_guild_type_idx" ON "tickets" USING btree ("guild_id","type_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_panel_idx" ON "tickets" USING btree ("guild_id","panel_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_owner_idx" ON "tickets" USING btree ("guild_id","owner_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_claimed_idx" ON "tickets" USING btree ("guild_id","claimed_by_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_opened_idx" ON "tickets" USING btree ("guild_id","opened_at");--> statement-breakpoint
CREATE INDEX "tickets_guild_closed_idx" ON "tickets" USING btree ("guild_id","closed_at");--> statement-breakpoint
CREATE INDEX "tickets_activity_idx" ON "tickets" USING btree ("last_activity_at") WHERE "tickets"."status" in ('open', 'closed');--> statement-breakpoint
CREATE TABLE "ticket_participants" (
	"ticket_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'added' NOT NULL,
	"added_by_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_id" text,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_form_answers" (
	"ticket_id" text NOT NULL,
	"field_id" text NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"message_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_bot" boolean DEFAULT false NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_blacklist" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ticket_ratings" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_form_answers" ADD CONSTRAINT "ticket_form_answers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_blacklist" ADD CONSTRAINT "ticket_blacklist_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_ratings" ADD CONSTRAINT "ticket_ratings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_participants_uq" ON "ticket_participants" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE INDEX "ticket_participants_user_idx" ON "ticket_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "ticket_events_guild_type_idx" ON "ticket_events" USING btree ("guild_id","type");--> statement-breakpoint
CREATE INDEX "ticket_events_actor_idx" ON "ticket_events" USING btree ("guild_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_form_answers_uq" ON "ticket_form_answers" USING btree ("ticket_id","field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_uq" ON "ticket_messages" USING btree ("ticket_id","message_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_messages_expiry_idx" ON "ticket_messages" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_blacklist_uq" ON "ticket_blacklist" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "ticket_blacklist_expiry_idx" ON "ticket_blacklist" USING btree ("expires_at") WHERE "ticket_blacklist"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "ticket_ratings_guild_idx" ON "ticket_ratings" USING btree ("guild_id","created_at");--> statement-breakpoint
INSERT INTO "ticket_participants" ("ticket_id", "user_id", "kind")
SELECT "id", "opener_id", 'opener' FROM "tickets"
ON CONFLICT DO NOTHING;
