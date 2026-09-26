CREATE TABLE "achievement_seen" (
	"guild_id" text NOT NULL,
	"metric" text NOT NULL,
	"source_key" text NOT NULL,
	"user_id" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"state" text DEFAULT 'counted' NOT NULL,
	"group_key" text,
	"channel_id" text,
	"parent_id" text,
	"category_id" text,
	"seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_seen_pk" PRIMARY KEY("guild_id","metric","source_key")
);
--> statement-breakpoint
CREATE TABLE "achievement_activity" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"metric" text NOT NULL,
	"hour" timestamp (3) with time zone NOT NULL,
	"channel_key" text DEFAULT '' NOT NULL,
	"channel_id" text,
	"parent_id" text,
	"category_id" text,
	"temporary" boolean DEFAULT false NOT NULL,
	"xp_source" text DEFAULT '' NOT NULL,
	"amount_sum" bigint DEFAULT 0 NOT NULL,
	"amount_max" integer DEFAULT 0 NOT NULL,
	"span_start" timestamp (3) with time zone,
	"events" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "achievement_activity_pk" PRIMARY KEY("guild_id","user_id","metric","hour","channel_key","temporary","xp_source")
);
--> statement-breakpoint
CREATE TABLE "achievement_progress" (
	"guild_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"user_id" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"version" integer NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_progress_pk" PRIMARY KEY("guild_id","achievement_id","user_id","requirement_id")
);
--> statement-breakpoint
CREATE TABLE "achievement_members" (
	"guild_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"user_id" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"reward_epoch" integer DEFAULT 0 NOT NULL,
	"counted_from" timestamp (3) with time zone,
	"reset_at" timestamp (3) with time zone,
	"reset_by" text,
	"almost_notified" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"almost_notified_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_members_pk" PRIMARY KEY("guild_id","achievement_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "achievement_state" (
	"guild_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"reward_epoch" integer DEFAULT 0 NOT NULL,
	"counted_from" timestamp (3) with time zone,
	"reset_at" timestamp (3) with time zone,
	"reset_by" text,
	"first_active_at" timestamp (3) with time zone,
	"job" text,
	"job_status" text,
	"job_cursor" text,
	"job_requested_at" timestamp (3) with time zone,
	"job_requested_by" text,
	"job_finished_at" timestamp (3) with time zone,
	"job_result" jsonb,
	"job_announce" boolean DEFAULT false NOT NULL,
	"job_accept_loss" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_state_pk" PRIMARY KEY("guild_id","achievement_id")
);
--> statement-breakpoint
CREATE TABLE "achievement_periods" (
	"guild_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	CONSTRAINT "achievement_periods_pk" PRIMARY KEY("guild_id","achievement_id","started_at")
);
--> statement-breakpoint
CREATE TABLE "achievement_unlocks" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"tier_id" text NOT NULL,
	"generation" integer NOT NULL,
	"tier_index" integer NOT NULL,
	"unlocked_at" timestamp (3) with time zone NOT NULL,
	"revision" text NOT NULL,
	"definition" jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cause" jsonb NOT NULL,
	"origin_channel_id" text,
	"announce_group" text NOT NULL,
	"announce_status" text DEFAULT 'pending' NOT NULL,
	"announce_attempts" integer DEFAULT 0 NOT NULL,
	"announce_lease_until" timestamp (3) with time zone,
	"announce_error" text,
	"announced_at" timestamp (3) with time zone,
	"announce_message_id" text,
	"published_at" timestamp (3) with time zone,
	"voided_at" timestamp (3) with time zone,
	"voided_by" text,
	CONSTRAINT "achievement_unlocks_pk" PRIMARY KEY("guild_id","user_id","achievement_id","tier_id","generation")
);
--> statement-breakpoint
CREATE TABLE "achievement_rewards" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"tier_id" text NOT NULL,
	"generation" integer NOT NULL,
	"reward_key" text NOT NULL,
	"reward_epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"role_id" text,
	"amount" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"next_attempt_at" timestamp (3) with time zone,
	"transient" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error" text,
	"requested_at" timestamp (3) with time zone,
	"delivered_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_rewards_pk" PRIMARY KEY("guild_id","user_id","achievement_id","tier_id","generation","reward_key")
);
--> statement-breakpoint
CREATE TABLE "achievement_member_facts" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp (3) with time zone,
	"premium_since" timestamp (3) with time zone,
	"left_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_member_facts_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "achievement_badges" (
	"guild_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"content_type" text NOT NULL,
	"base64" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_badges_pk" PRIMARY KEY("guild_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "achievement_seen" ADD CONSTRAINT "achievement_seen_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_activity" ADD CONSTRAINT "achievement_activity_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_progress" ADD CONSTRAINT "achievement_progress_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_members" ADD CONSTRAINT "achievement_members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_state" ADD CONSTRAINT "achievement_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_periods" ADD CONSTRAINT "achievement_periods_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_unlocks" ADD CONSTRAINT "achievement_unlocks_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_rewards" ADD CONSTRAINT "achievement_rewards_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_member_facts" ADD CONSTRAINT "achievement_member_facts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_badges" ADD CONSTRAINT "achievement_badges_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "achievement_seen_group_idx" ON "achievement_seen" USING btree ("guild_id","group_key") WHERE "achievement_seen"."group_key" is not null;--> statement-breakpoint
CREATE INDEX "achievement_activity_guild_metric_hour_idx" ON "achievement_activity" USING btree ("guild_id","metric","hour");--> statement-breakpoint
CREATE INDEX "achievement_activity_hour_idx" ON "achievement_activity" USING btree ("hour");--> statement-breakpoint
CREATE UNIQUE INDEX "achievement_periods_open_uq" ON "achievement_periods" USING btree ("guild_id","achievement_id") WHERE "achievement_periods"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "achievement_unlocks_guild_achievement_tier_idx" ON "achievement_unlocks" USING btree ("guild_id","achievement_id","tier_id");--> statement-breakpoint
CREATE INDEX "achievement_unlocks_pending_announce_idx" ON "achievement_unlocks" USING btree ("guild_id","announce_status") WHERE "achievement_unlocks"."announce_status" = 'pending';--> statement-breakpoint
CREATE INDEX "achievement_unlocks_unpublished_idx" ON "achievement_unlocks" USING btree ("guild_id") WHERE "achievement_unlocks"."published_at" is null;--> statement-breakpoint
CREATE INDEX "achievement_rewards_guild_status_due_idx" ON "achievement_rewards" USING btree ("guild_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "achievement_rewards_epoch_idx" ON "achievement_rewards" USING btree ("guild_id","user_id","achievement_id","tier_id","reward_key","reward_epoch");--> statement-breakpoint
CREATE INDEX "achievement_member_facts_joined_idx" ON "achievement_member_facts" USING btree ("guild_id","joined_at");
