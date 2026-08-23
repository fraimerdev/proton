-- The embeds module became `messages`, and its `saved` config key became `templates`.
-- Config first, so a row is never left carrying the new module id and the old shape.
UPDATE "guild_modules"
   SET "config" = ("config" - 'saved') || jsonb_build_object('templates', "config" -> 'saved')
 WHERE "module_id" = 'embeds'
   AND "config" ? 'saved'
   AND NOT ("config" ? 'templates');
--> statement-breakpoint
-- A guild that already has a `messages` row cannot take the rename: the primary key is
-- (guild_id, module_id), so the update would collide. That row is the newer one — drop the old.
DELETE FROM "guild_modules" old
 WHERE old."module_id" = 'embeds'
   AND EXISTS (
     SELECT 1 FROM "guild_modules" held
      WHERE held."guild_id" = old."guild_id" AND held."module_id" = 'messages'
   );
--> statement-breakpoint
UPDATE "guild_modules" SET "module_id" = 'messages', "schema_version" = 4 WHERE "module_id" = 'embeds';
