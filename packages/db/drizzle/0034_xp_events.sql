CREATE TABLE "xp_events" (
	"guild_id" text NOT NULL,
	"id" text NOT NULL,
	"multiplier_tenths" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xp_events_guild_id_id_pk" PRIMARY KEY("guild_id","id")
);
--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "xp_events_guild_ends_idx" ON "xp_events" USING btree ("guild_id","ends_at");
