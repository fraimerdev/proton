-- Locks the old build still holds are left alone: clearing them would hand a running job to a
-- second sweeper. They carry no token, so they are only claimable again once they lapse.
ALTER TABLE "scheduled_actions" ADD COLUMN "lock_token" text;
