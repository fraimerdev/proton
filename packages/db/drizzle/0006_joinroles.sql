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
