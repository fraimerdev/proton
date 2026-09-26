CREATE TABLE "guild_commands" (
	"guild_id" text NOT NULL,
	"command_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"name" text,
	"description" text,
	"option_descriptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"private_reply" boolean,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_commands_guild_id_command_key_pk" PRIMARY KEY("guild_id","command_key")
);
--> statement-breakpoint
CREATE TABLE "guild_command_registrations" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"definition_hash" text,
	"commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"id_history" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"failure" jsonb,
	"permissions_checked_at" timestamp with time zone,
	"lost_permissions" jsonb,
	"lost_permissions_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "guild_commands" ADD CONSTRAINT "guild_commands_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_command_registrations" ADD CONSTRAINT "guild_command_registrations_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
