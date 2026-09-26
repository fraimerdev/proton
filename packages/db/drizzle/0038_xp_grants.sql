CREATE TABLE "xp_grants" (
	"guild_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"source_module" text NOT NULL,
	"causation" jsonb NOT NULL,
	"previous_level" integer NOT NULL,
	"level" integer NOT NULL,
	"xp_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xp_grants_guild_id_grant_id_pk" PRIMARY KEY("guild_id","grant_id")
);
--> statement-breakpoint
ALTER TABLE "xp_grants" ADD CONSTRAINT "xp_grants_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
