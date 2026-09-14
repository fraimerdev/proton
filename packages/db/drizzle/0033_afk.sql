CREATE TABLE "afk_statuses" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"reason" text,
	"since" timestamp with time zone NOT NULL,
	"previous_nick" text,
	"applied_nick" text,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	CONSTRAINT "afk_statuses_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id"),
	CONSTRAINT "afk_statuses_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "afk_pings" (
	"session_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"pinged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "afk_pings_session_id_message_id_pk" PRIMARY KEY("session_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "afk_statuses" ADD CONSTRAINT "afk_statuses_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "afk_pings" ADD CONSTRAINT "afk_pings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "afk_pings_guild_user_idx" ON "afk_pings" USING btree ("guild_id","user_id");
