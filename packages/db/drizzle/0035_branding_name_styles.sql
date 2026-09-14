CREATE TABLE "branding_name_styles" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"requested" jsonb,
	"outcome" text NOT NULL,
	"reason" text,
	"confirmed" jsonb,
	"attempted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branding_name_styles" ADD CONSTRAINT "branding_name_styles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
