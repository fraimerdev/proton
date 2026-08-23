CREATE TABLE "giveaways" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"prize" text NOT NULL,
	"winner_count" integer NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"winner_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaway_entries" (
	"giveaway_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_entries_pk" PRIMARY KEY ("giveaway_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "giveaways_guild_running_idx" ON "giveaways" USING btree ("guild_id") WHERE "giveaways"."ended_at" is null;
