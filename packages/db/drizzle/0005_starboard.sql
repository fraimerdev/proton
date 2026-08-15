CREATE TABLE "starboard_posts" (
	"guild_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"board_message_id" text NOT NULL,
	"star_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starboard_posts_pk" PRIMARY KEY ("guild_id","source_message_id")
);
--> statement-breakpoint
ALTER TABLE "starboard_posts" ADD CONSTRAINT "starboard_posts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
