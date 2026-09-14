-- false, not moderation's default: a guild with no moderation row reads as switched off today.
INSERT INTO "guild_modules" ("guild_id", "module_id", "enabled", "config", "schema_version")
SELECT c."guild_id", 'moderation', false, '{"enabled": false}'::jsonb, 2
  FROM "guild_modules" c
 WHERE c."module_id" = 'cases'
   AND (jsonb_typeof(c."config" -> 'escalationWindow') <> 'null'
        OR jsonb_typeof(c."config" -> 'escalationLadder') <> 'null')
   AND NOT EXISTS (
     SELECT 1 FROM "guild_modules" m
      WHERE m."guild_id" = c."guild_id" AND m."module_id" = 'moderation'
   );
--> statement-breakpoint

-- Carried keys on the left: a ladder the moderation row already holds is newer, as its rules are below.
UPDATE "guild_modules" m
   SET "config" = coalesce(
         (SELECT jsonb_object_agg(moved."key", c."config" -> moved."key")
            FROM "guild_modules" c
            CROSS JOIN unnest(ARRAY['escalationWindow', 'escalationLadder']) AS moved("key")
           WHERE c."guild_id" = m."guild_id"
             AND c."module_id" = 'cases'
             AND jsonb_typeof(c."config" -> moved."key") <> 'null'),
         '{}'::jsonb
       ) || m."config",
       "schema_version" = 2
 WHERE m."module_id" = 'moderation';
--> statement-breakpoint

UPDATE "guild_modules"
   SET "config" = "config" - 'escalationWindow' - 'escalationLadder',
       "schema_version" = 2
 WHERE "module_id" = 'cases';
--> statement-breakpoint

-- A moderation row already holding the id wins; the cases row it would collide with is deleted next.
UPDATE "rules" r
   SET "id" = r."guild_id" || ':moderation:' || substring(r."id" from length(r."guild_id" || ':cases:') + 1),
       "module_id" = 'moderation'
 WHERE r."module_id" = 'cases'
   AND starts_with(r."id", r."guild_id" || ':cases:escalate-at-')
   AND NOT EXISTS (
     SELECT 1 FROM "rules" held
      WHERE held."id" = r."guild_id" || ':moderation:' || substring(r."id" from length(r."guild_id" || ':cases:') + 1)
   );
--> statement-breakpoint

DELETE FROM "rules"
 WHERE "module_id" = 'cases'
   AND starts_with("id", "guild_id" || ':cases:escalate-at-');
--> statement-breakpoint

-- The old seeder put back every shipped rung a guild deleted; 3 and 5 are the ladder a row without one reads as.
DELETE FROM "rules" r
 WHERE r."module_id" = 'moderation'
   AND starts_with(r."id", r."guild_id" || ':moderation:escalate-at-')
   AND NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements(coalesce(
              (SELECT m."config" -> 'escalationLadder'
                 FROM "guild_modules" m
                WHERE m."guild_id" = r."guild_id"
                  AND m."module_id" = 'moderation'
                  AND jsonb_typeof(m."config" -> 'escalationLadder') = 'array'),
              '[{"atWarnings": 3}, {"atWarnings": 5}]'::jsonb
            )) AS rung
      WHERE r."id" = r."guild_id" || ':moderation:escalate-at-' || (rung ->> 'atWarnings')
   );
