CREATE TABLE "branding_assets" (
	"guild_id" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"base64" text NOT NULL,
	"hash" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branding_assets_guild_id_kind_pk" PRIMARY KEY("guild_id","kind")
);
--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
