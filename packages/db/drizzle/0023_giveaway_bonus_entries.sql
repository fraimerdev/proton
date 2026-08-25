CREATE TABLE "giveaway_bonus_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"giveaway_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "giveaway_bonus_entries" ADD CONSTRAINT "giveaway_bonus_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "giveaway_bonus_live_idx" ON "giveaway_bonus_entries" ("giveaway_id","user_id") WHERE "revoked_at" IS NULL;
