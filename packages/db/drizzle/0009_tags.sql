CREATE TABLE "tags" (
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_pk" PRIMARY KEY ("guild_id","name")
);
--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tags_guild_uses_idx" ON "tags" USING btree ("guild_id","uses" DESC NULLS LAST);
