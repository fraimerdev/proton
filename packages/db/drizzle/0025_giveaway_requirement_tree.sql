ALTER TABLE "giveaways" ADD COLUMN "requirement_tree" jsonb;--> statement-breakpoint
UPDATE "giveaways" g
   SET "requirement_tree" = jsonb_build_object(
         'kind', 'group',
         'logic', g."requirement_logic",
         'children', (
           SELECT jsonb_agg(
                    jsonb_build_object('kind', 'leaf', 'providerId', r."provider_id", 'config', r."config")
                    ORDER BY r."position"
                  )
             FROM "giveaway_requirements" r
            WHERE r."giveaway_id" = g."id"
         )
       )
 WHERE EXISTS (SELECT 1 FROM "giveaway_requirements" r WHERE r."giveaway_id" = g."id");
