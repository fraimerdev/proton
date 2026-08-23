-- Without the discriminator the sweeper cannot parse these rows, so a pending temp ban never lifts.
UPDATE "scheduled_actions"
SET "payload" = jsonb_set("payload", '{kind}', '"reversal"')
WHERE jsonb_typeof("payload") = 'object'
  AND "payload"->>'kind' IS NULL;
