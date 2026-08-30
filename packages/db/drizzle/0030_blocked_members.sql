CREATE TABLE "blocked_members" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"module_id" text NOT NULL,
	"blocked_by" text NOT NULL,
	"reason" text NOT NULL,
	"case_id" text,
	"evidence" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"lift_reason" text
);
--> statement-breakpoint
ALTER TABLE "blocked_members" ADD CONSTRAINT "blocked_members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_members_idempotency_key_uq" ON "blocked_members" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_members_live_uq" ON "blocked_members" USING btree ("guild_id","user_id") WHERE "blocked_members"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "blocked_members_guild_created_idx" ON "blocked_members" USING btree ("guild_id","created_at" DESC NULLS LAST);
