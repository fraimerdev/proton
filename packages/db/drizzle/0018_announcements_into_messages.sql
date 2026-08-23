-- The announcements module is retired into scheduled message templates.
--
-- Order matters throughout: config first, then the booked rows, then the module row. A booked row
-- rewritten before its template exists would fire into a template the guild does not have yet.

-- A guild with announcements but no messages row gets one, so the merge below has somewhere to go.
-- Disabled, because a schedule is only live while the module that owns it is on and this guild has
-- never switched Messages on — reconcile books them the moment it does.
INSERT INTO "guild_modules" ("guild_id", "module_id", "enabled", "config", "schema_version")
SELECT a."guild_id", 'messages', false, '{"enabled": false, "templates": [], "components": []}'::jsonb, 4
  FROM "guild_modules" a
 WHERE a."module_id" = 'announcements'
   AND NOT EXISTS (
     SELECT 1 FROM "guild_modules" m
      WHERE m."guild_id" = a."guild_id" AND m."module_id" = 'messages'
   );
--> statement-breakpoint

-- Each announcement becomes a template carrying a schedule. The announcement's id becomes the
-- template name: it is already a lowercase slug, and it is the natural key every booked row in
-- scheduled_actions carries, so keeping it is what lets those rows survive this migration.
UPDATE "guild_modules" m
   SET "config" = jsonb_set(
         m."config",
         '{templates}',
         coalesce(m."config" -> 'templates', '[]'::jsonb) || coalesce(moved."templates", '[]'::jsonb)
       )
  FROM (
    SELECT a."guild_id",
           jsonb_agg(
             jsonb_build_object(
               'name', ann ->> 'id',
               'content', ann ->> 'message',
               'embeds', '[]'::jsonb,
               'components', '[]'::jsonb,
               'v2', '[]'::jsonb,
               'mentions', jsonb_build_object('everyone', false, 'roles', true, 'users', true),
               'schedule', jsonb_strip_nulls(
                 jsonb_build_object(
                   'channelId', ann ->> 'channelId',
                   'at', ann ->> 'at',
                   'mode', coalesce(ann ->> 'mode', 'once'),
                   'every', ann ->> 'every',
                   'pingRoleId', ann ->> 'pingRoleId',
                   'enabled', coalesce((ann ->> 'enabled')::boolean, true)
                 )
               )
             )
           ) AS "templates"
      FROM "guild_modules" a
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(a."config" -> 'scheduled', '[]'::jsonb)) AS ann
     WHERE a."module_id" = 'announcements'
       -- An announcement whose id already names a template would collide on /message post, and
       -- the template that is already there is the one the admin last edited.
       AND NOT EXISTS (
         SELECT 1
           FROM "guild_modules" held
           CROSS JOIN LATERAL jsonb_array_elements(coalesce(held."config" -> 'templates', '[]'::jsonb)) AS t
          WHERE held."guild_id" = a."guild_id"
            AND held."module_id" = 'messages'
            AND lower(t ->> 'name') = lower(ann ->> 'id')
       )
     GROUP BY a."guild_id"
  ) AS moved
 WHERE m."module_id" = 'messages' AND m."guild_id" = moved."guild_id";
--> statement-breakpoint

-- Every booked post moves to the messages module. The idempotency key is
-- `<moduleId>:<jobId>:<guildId>:<naturalKey>` and neither module id nor job id can contain the
-- separator, so the prefix is a literal swap; the natural key is unchanged because the template
-- kept the announcement's id as its name.
UPDATE "scheduled_actions"
   SET "idempotency_key" = 'messages:post:' || substring("idempotency_key" from length('announcements:post:') + 1),
       "payload" = jsonb_set(
         jsonb_set("payload", '{moduleId}', '"messages"'::jsonb),
         '{data}',
         ("payload" -> 'data')
           - 'announcementId'
           || jsonb_build_object('templateName', "payload" -> 'data' ->> 'announcementId')
       )
 WHERE "kind" = 'module_job'
   AND "payload" ->> 'moduleId' = 'announcements'
   AND "payload" ->> 'jobId' = 'post'
   AND "payload" -> 'data' ? 'announcementId'
   -- A key already taken by a messages row cannot be rewritten onto: the column is unique, and the
   -- row holding it is the newer booking.
   AND NOT EXISTS (
     SELECT 1 FROM "scheduled_actions" held
      WHERE held."idempotency_key" =
            'messages:post:' || substring("scheduled_actions"."idempotency_key" from length('announcements:post:') + 1)
   );
--> statement-breakpoint

-- Anything still booked under the old module would fire into a handler that no longer exists.
DELETE FROM "scheduled_actions"
 WHERE "kind" = 'module_job' AND "payload" ->> 'moduleId' = 'announcements';
--> statement-breakpoint

DELETE FROM "guild_modules" WHERE "module_id" = 'announcements';
