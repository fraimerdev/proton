CREATE TABLE "application_form_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"form_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"draft_policy" text DEFAULT 'keep' NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"number" integer,
	"form_id" text NOT NULL,
	"version_id" text NOT NULL,
	"applicant_id" text NOT NULL,
	"applicant_name" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"answers" jsonb,
	"source" text,
	"assignee_id" text,
	"assigned_at" timestamp (3) with time zone,
	"submitted_at" timestamp (3) with time zone,
	"review_started_at" timestamp (3) with time zone,
	"info_requested_at" timestamp (3) with time zone,
	"info_due_at" timestamp (3) with time zone,
	"waitlisted_at" timestamp (3) with time zone,
	"decided_at" timestamp (3) with time zone,
	"decided_by" text,
	"decision_reason" text,
	"withdrawn_at" timestamp (3) with time zone,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"review_due_at" timestamp (3) with time zone,
	"reminded_at" timestamp (3) with time zone,
	"content_purge_at" timestamp (3) with time zone,
	"content_purged_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone,
	"dm_channel_id" text,
	"card_channel_id" text,
	"card_message_id" text,
	"card_revision" integer DEFAULT -1 NOT NULL,
	"interview_ticket_id" text,
	"interview_channel_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"revision" integer NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text,
	"revision" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"application_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_votes" (
	"guild_id" text NOT NULL,
	"application_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"vote" text NOT NULL,
	"score" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_votes_pk" PRIMARY KEY("application_id","reviewer_id")
);
--> statement-breakpoint
CREATE TABLE "application_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"application_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"revision" integer NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_seq" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_role_grants" (
	"guild_id" text NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"granted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp (3) with time zone,
	CONSTRAINT "application_role_grants_pk" PRIMARY KEY("application_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "source_module" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "application_form_versions" ADD CONSTRAINT "application_form_versions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_version_id_application_form_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."application_form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_thread" ADD CONSTRAINT "application_thread_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_thread" ADD CONSTRAINT "application_thread_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_votes" ADD CONSTRAINT "application_votes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_votes" ADD CONSTRAINT "application_votes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_effects" ADD CONSTRAINT "application_effects_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_effects" ADD CONSTRAINT "application_effects_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_grants" ADD CONSTRAINT "application_role_grants_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_role_grants" ADD CONSTRAINT "application_role_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_form_versions_guild_form_version_uq" ON "application_form_versions" USING btree ("guild_id","form_id","version");--> statement-breakpoint
CREATE INDEX "application_form_versions_guild_form_idx" ON "application_form_versions" USING btree ("guild_id","form_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "applications_guild_number_uq" ON "applications" USING btree ("guild_id","number") WHERE "applications"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_one_draft_uq" ON "applications" USING btree ("guild_id","form_id","applicant_id") WHERE "applications"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "applications_guild_status_submitted_idx" ON "applications" USING btree ("guild_id","status","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_guild_form_status_idx" ON "applications" USING btree ("guild_id","form_id","status");--> statement-breakpoint
CREATE INDEX "applications_guild_applicant_created_idx" ON "applications" USING btree ("guild_id","applicant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_applicant_created_idx" ON "applications" USING btree ("applicant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_guild_assignee_idx" ON "applications" USING btree ("guild_id","assignee_id") WHERE "applications"."status" in ('submitted', 'in_review', 'needs_info', 'waitlisted');--> statement-breakpoint
CREATE INDEX "applications_draft_expiry_idx" ON "applications" USING btree ("expires_at") WHERE "applications"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "applications_content_purge_idx" ON "applications" USING btree ("content_purge_at") WHERE "applications"."content_purged_at" is null;--> statement-breakpoint
CREATE INDEX "applications_review_due_idx" ON "applications" USING btree ("guild_id","review_due_at") WHERE "applications"."reminded_at" is null and "applications"."status" in ('submitted', 'in_review');--> statement-breakpoint
CREATE INDEX "applications_info_due_idx" ON "applications" USING btree ("guild_id","info_due_at") WHERE "applications"."status" = 'needs_info';--> statement-breakpoint
CREATE INDEX "application_events_application_created_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "application_thread_application_created_idx" ON "application_thread" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "application_notes_application_created_idx" ON "application_notes" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "application_effects_application_key_uq" ON "application_effects" USING btree ("application_id","key");--> statement-breakpoint
CREATE INDEX "application_effects_guild_status_due_idx" ON "application_effects" USING btree ("guild_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_source_open_uq" ON "tickets" USING btree ("guild_id","source_module","source_ref") WHERE "tickets"."source_ref" is not null and "tickets"."status" = 'open';
