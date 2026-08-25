CREATE TABLE "giveaway_events" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"giveaway_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"detail" jsonb,
	"idempotency_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "giveaway_events_timeline_idx" ON "giveaway_events" ("giveaway_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_events_once" ON "giveaway_events" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
