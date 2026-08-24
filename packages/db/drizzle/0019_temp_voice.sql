CREATE TABLE "temp_voice_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"hub_channel_id" text NOT NULL,
	"channel_id" text,
	"owner_id" text,
	"status" text DEFAULT 'reserving' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "temp_voice_access" (
	"temp_channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temp_voice_roles" (
	"temp_channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "temp_voice_channels" ADD CONSTRAINT "temp_voice_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temp_voice_access" ADD CONSTRAINT "temp_voice_access_temp_channel_id_fk" FOREIGN KEY ("temp_channel_id") REFERENCES "public"."temp_voice_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temp_voice_roles" ADD CONSTRAINT "temp_voice_roles_temp_channel_id_fk" FOREIGN KEY ("temp_channel_id") REFERENCES "public"."temp_voice_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "temp_voice_channel_uq" ON "temp_voice_channels" USING btree ("guild_id","channel_id") WHERE "temp_voice_channels"."channel_id" is not null;--> statement-breakpoint
CREATE INDEX "temp_voice_owner_idx" ON "temp_voice_channels" USING btree ("guild_id","owner_id") WHERE "temp_voice_channels"."status" = 'live';--> statement-breakpoint
CREATE INDEX "temp_voice_guild_status_idx" ON "temp_voice_channels" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "temp_voice_sweep_idx" ON "temp_voice_channels" USING btree ("delete_after") WHERE "temp_voice_channels"."delete_after" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "temp_voice_access_uq" ON "temp_voice_access" USING btree ("temp_channel_id","user_id");--> statement-breakpoint
CREATE INDEX "temp_voice_access_channel_idx" ON "temp_voice_access" USING btree ("temp_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "temp_voice_role_uq" ON "temp_voice_roles" USING btree ("temp_channel_id","user_id","role_id");--> statement-breakpoint
CREATE INDEX "temp_voice_role_user_idx" ON "temp_voice_roles" USING btree ("user_id");
