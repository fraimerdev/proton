CREATE TABLE "counter_channels" (
	"guild_id" text NOT NULL,
	"counter_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counter_channels_guild_id_counter_id_pk" PRIMARY KEY("guild_id","counter_id")
);
--> statement-breakpoint
ALTER TABLE "counter_channels" ADD CONSTRAINT "counter_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
