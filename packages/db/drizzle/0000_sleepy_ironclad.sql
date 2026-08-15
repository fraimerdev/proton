CREATE TABLE "audit_trail" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb,
	"s3_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"case_number" integer NOT NULL,
	"type" text NOT NULL,
	"actor_id" text,
	"target_id" text,
	"moderator_id" text,
	"reason" text,
	"module_id" text NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"reverted_by" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"guild_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"tier" text NOT NULL,
	"source" text NOT NULL,
	"expires_at" timestamp with time zone,
	"discord_entitlement_id" text,
	CONSTRAINT "entitlements_guild_id_sku_id_pk" PRIMARY KEY("guild_id","sku_id")
);
--> statement-breakpoint
CREATE TABLE "guild_modules" (
	"guild_id" text NOT NULL,
	"module_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_modules_guild_id_module_id_pk" PRIMARY KEY("guild_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"shard_id" integer
);
--> statement-breakpoint
CREATE TABLE "members" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"last_xp_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"voice_seconds" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone,
	"sticky_roles" bigint[],
	CONSTRAINT "members_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"module_id" text NOT NULL,
	"trigger" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "scheduled_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_trail" ADD CONSTRAINT "audit_trail_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_modules" ADD CONSTRAINT "guild_modules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_trail_guild_created_idx" ON "audit_trail" USING btree ("guild_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "cases_guild_case_number_uq" ON "cases" USING btree ("guild_id","case_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_idempotency_key_uq" ON "cases" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "cases_guild_target_created_idx" ON "cases" USING btree ("guild_id","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cases_pending_expiry_idx" ON "cases" USING btree ("expires_at") WHERE "cases"."expires_at" is not null and "cases"."reverted_at" is null;--> statement-breakpoint
CREATE INDEX "rules_guild_trigger_idx" ON "rules" USING btree ("guild_id","trigger");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_actions_idempotency_key_uq" ON "scheduled_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "scheduled_actions_due_idx" ON "scheduled_actions" USING btree ("run_at");
