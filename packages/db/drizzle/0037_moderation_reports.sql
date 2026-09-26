CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"number" integer NOT NULL,
	"reporter_id" text NOT NULL,
	"target_id" text NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason_id" text,
	"reason" text,
	"custom_reason" text,
	"comment" text,
	"source_channel_id" text,
	"source_message_id" text,
	"source_author_id" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_expires_at" timestamp with time zone,
	"evidence_purged_at" timestamp with time zone,
	"assignee_id" text,
	"assigned_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"reporter_note" text,
	"action_kind" text,
	"case_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"card_channel_id" text,
	"card_message_id" text,
	"evidence_message_id" text,
	"card_state" text DEFAULT 'pending' NOT NULL,
	"card_error" text,
	"card_attempts" integer DEFAULT 0 NOT NULL,
	"card_version" integer DEFAULT 0 NOT NULL,
	"card_edit_attempts" integer DEFAULT 0 NOT NULL,
	"close_action" text,
	"close_due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_attempts" integer DEFAULT 0 NOT NULL,
	"close_error" text,
	"decision_token" text,
	"decision_kind" text,
	"decision_started_at" timestamp with time zone,
	"notifications" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dm_channel_id" text,
	"dm_attempts" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_events" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"source" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"target_id" text NOT NULL,
	"episode_start" timestamp (3) with time zone NOT NULL,
	"covered_until" timestamp (3) with time zone NOT NULL,
	"report_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moderation_timeouts" (
	"case_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"applied_until" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" text,
	"expiry_logged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moderation_case_messages" (
	"case_id" text NOT NULL,
	"message_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"proof" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "moderation_case_messages_pk" PRIMARY KEY("case_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_events" ADD CONSTRAINT "report_events_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_events" ADD CONSTRAINT "report_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_automation_runs" ADD CONSTRAINT "report_automation_runs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_timeouts" ADD CONSTRAINT "moderation_timeouts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_case_messages" ADD CONSTRAINT "moderation_case_messages_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_guild_number_uq" ON "reports" USING btree ("guild_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_idempotency_key_uq" ON "reports" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "reports_guild_status_created_idx" ON "reports" USING btree ("guild_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_guild_target_created_idx" ON "reports" USING btree ("guild_id","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_guild_reporter_created_idx" ON "reports" USING btree ("guild_id","reporter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_guild_card_message_idx" ON "reports" USING btree ("guild_id","card_message_id") WHERE "reports"."card_message_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_evidence_expiry_idx" ON "reports" USING btree ("evidence_expires_at") WHERE "reports"."evidence_purged_at" is null and "reports"."evidence_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "reports_close_due_idx" ON "reports" USING btree ("guild_id","close_due_at") WHERE "reports"."closed_at" is null and "reports"."close_due_at" is not null;--> statement-breakpoint
CREATE INDEX "report_events_report_created_idx" ON "report_events" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_automation_runs_episode_uq" ON "report_automation_runs" USING btree ("guild_id","rule_id","target_id","episode_start");--> statement-breakpoint
CREATE INDEX "report_automation_runs_guild_created_idx" ON "report_automation_runs" USING btree ("guild_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "report_automation_runs_running_idx" ON "report_automation_runs" USING btree ("guild_id","created_at") WHERE "report_automation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "moderation_timeouts_open_idx" ON "moderation_timeouts" USING btree ("guild_id","user_id") WHERE "moderation_timeouts"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "moderation_case_messages_guild_case_idx" ON "moderation_case_messages" USING btree ("guild_id","case_id");--> statement-breakpoint
CREATE INDEX "moderation_case_messages_expiry_idx" ON "moderation_case_messages" USING btree ("expires_at");
