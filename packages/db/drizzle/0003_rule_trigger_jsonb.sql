DROP INDEX "rules_guild_trigger_idx";--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "trigger" SET DATA TYPE jsonb
  USING jsonb_build_object('kind', 'event', 'event', "trigger");--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "trigger_event" text GENERATED ALWAYS AS (case when "trigger" ->> 'kind' = 'event' then "trigger" ->> 'event' end) STORED;--> statement-breakpoint
CREATE INDEX "rules_guild_trigger_event_idx" ON "rules" USING btree ("guild_id","trigger_event");
