UPDATE "user" SET "email" = "account"."accountId" || '@users.discord.invalid', "emailVerified" = false FROM "account" WHERE "account"."userId" = "user"."id" AND "account"."providerId" = 'discord';
--> statement-breakpoint
UPDATE "session" SET "ipAddress" = NULL, "userAgent" = NULL;
--> statement-breakpoint
UPDATE "audit_trail" SET "ip_hash" = NULL WHERE "ip_hash" IS NOT NULL;
