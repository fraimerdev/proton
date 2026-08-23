ALTER TABLE "giveaways" RENAME COLUMN "prize" TO "title";--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "host_id" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "banner_url" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "color" integer;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "button_style" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "requirement_logic" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "max_entries_per_user" integer;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "verify_on" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "status" text DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "drawing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "claim_window_seconds" integer;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "dm_winners" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "win_message" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "recurrence" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "giveaways" SET "host_id" = "created_by" WHERE "host_id" IS NULL;--> statement-breakpoint
UPDATE "giveaways" SET "status" = 'ended' WHERE "ended_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ALTER COLUMN "host_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "giveaways_due_idx" ON "giveaways" USING btree ("ends_at") WHERE "giveaways"."status" = 'running';--> statement-breakpoint
ALTER TABLE "giveaway_entries" RENAME COLUMN "entered_at" TO "joined_at";--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "base_entries" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "total_entries" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "member_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "revalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "disqualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "disqualify_reason" text;--> statement-breakpoint
CREATE INDEX "giveaway_entries_live_idx" ON "giveaway_entries" USING btree ("giveaway_id","user_id") WHERE "giveaway_entries"."disqualified_at" IS NULL;--> statement-breakpoint
CREATE TABLE "giveaway_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"giveaway_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaway_requirements" ADD CONSTRAINT "giveaway_requirements_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "giveaway_requirements_giveaway_idx" ON "giveaway_requirements" USING btree ("giveaway_id","position");--> statement-breakpoint
CREATE TABLE "giveaway_multipliers" (
	"id" text PRIMARY KEY NOT NULL,
	"giveaway_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"mode" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaway_multipliers" ADD CONSTRAINT "giveaway_multipliers_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "giveaway_multipliers_giveaway_idx" ON "giveaway_multipliers" USING btree ("giveaway_id","position");--> statement-breakpoint
CREATE TABLE "giveaway_draws" (
	"id" text PRIMARY KEY NOT NULL,
	"giveaway_id" text NOT NULL,
	"draw_number" integer NOT NULL,
	"seed" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"entrant_count" integer NOT NULL,
	"total_entries" integer NOT NULL,
	"winner_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"degraded_providers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"drawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drawn_by" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "giveaway_draws" ADD CONSTRAINT "giveaway_draws_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_draws_unique" ON "giveaway_draws" USING btree ("giveaway_id","draw_number");--> statement-breakpoint
INSERT INTO "giveaway_draws" ("id","giveaway_id","draw_number","seed","snapshot_hash","entrant_count","total_entries","winner_ids","drawn_at","drawn_by","reason")
SELECT g."id" || ':1', g."id", 1, 'legacy', 'legacy',
       (SELECT count(*) FROM "giveaway_entries" e WHERE e."giveaway_id" = g."id"),
       (SELECT count(*) FROM "giveaway_entries" e WHERE e."giveaway_id" = g."id"),
       g."winner_ids", coalesce(g."ended_at", now()), g."created_by",
       'migrated from the pre-registry giveaways module'
  FROM "giveaways" g
 WHERE g."ended_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "winner_ids";--> statement-breakpoint
CREATE TABLE "giveaway_wins" (
	"giveaway_id" text NOT NULL,
	"draw_id" text NOT NULL,
	"user_id" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"forfeited_at" timestamp with time zone,
	"rerolled_at" timestamp with time zone,
	"claim_deadline" timestamp with time zone,
	CONSTRAINT "giveaway_wins_pk" PRIMARY KEY("draw_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "giveaway_wins" ADD CONSTRAINT "giveaway_wins_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_wins" ADD CONSTRAINT "giveaway_wins_draw_id_giveaway_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."giveaway_draws"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "giveaway_wins_recent_idx" ON "giveaway_wins" USING btree ("giveaway_id","user_id");--> statement-breakpoint
INSERT INTO "giveaway_wins" ("giveaway_id","draw_id","user_id")
SELECT d."giveaway_id", d."id", w
  FROM "giveaway_draws" d, unnest(d."winner_ids") AS w
 WHERE d."seed" = 'legacy';
--> statement-breakpoint
CREATE TABLE "giveaway_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaway_templates" ADD CONSTRAINT "giveaway_templates_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_templates_name" ON "giveaway_templates" USING btree ("guild_id","name");--> statement-breakpoint
CREATE TABLE "giveaway_blacklist" (
	"guild_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"added_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_blacklist_pk" PRIMARY KEY("guild_id","subject_type","subject_id")
);
--> statement-breakpoint
ALTER TABLE "giveaway_blacklist" ADD CONSTRAINT "giveaway_blacklist_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
