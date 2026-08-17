-- A guild that configured Join Roles after the rename shipped but before this migration ran
-- already has a joinroles row. It is newer and richer than the autorole one, so it wins and the
-- legacy row is dropped — renaming onto it would violate the (guild_id, module_id) primary key.
DELETE FROM "guild_modules" AS legacy
WHERE legacy."module_id" = 'autorole'
  AND EXISTS (
    SELECT 1
    FROM "guild_modules" AS current
    WHERE current."guild_id" = legacy."guild_id"
      AND current."module_id" = 'joinroles'
  );
--> statement-breakpoint
-- Zod strips unknown keys, so a bare module_id rename would let ModuleConfigService.get() parse
-- the old row cleanly and silently drop every configured role. The config is rewritten in place.
UPDATE "guild_modules"
SET "module_id" = 'joinroles',
    "schema_version" = 2,
    "config" = jsonb_build_object(
      'enabled', to_jsonb(
        COALESCE(("config"->>'enabled')::boolean, false)
        OR jsonb_array_length(COALESCE("config"->'autoroleIds', '[]'::jsonb)) > 0
      ),
      'memberRoleIds', COALESCE("config"->'autoroleIds', '[]'::jsonb),
      'botRoleIds', '[]'::jsonb,
      'grantWhenScreeningPasses', to_jsonb(true),
      'stickyEnabled', COALESCE("config"->'stickyEnabled', to_jsonb(false)),
      'stickyRoleIds', COALESCE("config"->'stickyRoleIds', '[]'::jsonb)
    )
WHERE "module_id" = 'autorole';
--> statement-breakpoint
DELETE FROM "rules" WHERE "module_id" = 'autorole';
