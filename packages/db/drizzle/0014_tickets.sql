CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"number" integer NOT NULL,
	"panel_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"opener_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" text
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_guild_number_uq" ON "tickets" USING btree ("guild_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_open_channel_uq" ON "tickets" USING btree ("guild_id","channel_id") WHERE "tickets"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tickets_guild_opener_open_idx" ON "tickets" USING btree ("guild_id","opener_id") WHERE "tickets"."status" = 'open';
