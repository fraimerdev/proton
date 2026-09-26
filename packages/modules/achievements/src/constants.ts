import type { LedgerMetric } from './triggers.ts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const ACHIEVEMENTS_ACTOR = 'proton:achievements';

export const DEADLINE_GRACE_MS = HOUR_MS;

export const ACTIVITY_RETENTION_DAYS = 365;

export const MAX_CAUSATION_DEPTH = 8;

export const VOICE_CHECKPOINT_MS = 10 * MINUTE_MS;

export const VOICE_PREFIX = 'proton:achievements:voice';

export const STATE_CHECK_TTL_MS = 10 * MINUTE_MS;

export const XP_CONFIRM_TIMEOUT_MS = 2 * MINUTE_MS;

export const MAX_REWARD_ATTEMPTS = 5;

export const MAX_ANNOUNCE_ATTEMPTS = 3;

export const REACTION_MAX_AGE_MS = 7 * DAY_MS;

export const REACTIONS_GIVEN_DAILY_CAP = 50;

export const REACTIONS_PAIR_DAILY_CAP = 5;

export const JOB_SLICE = 500;

export const SEEN_RETENTION_MS: Record<LedgerMetric, number | null> = {
  messages: 2 * DAY_MS,
  active_days: 2 * DAY_MS,
  voice_minutes: 2 * DAY_MS,
  voice_stay: 2 * DAY_MS,
  activity_xp: 2 * DAY_MS,
  reactions_given: 8 * DAY_MS,
  reactions_received: 8 * DAY_MS,
  starboard_messages: null,
  boosts: null,
  giveaways_entered: null,
  giveaways_won: null,
  applications_accepted: null,
};

export const GROUP_RELEASE_METRIC = 'group_release';

export const ACTIVE_DAY_TARGET_METRIC = 'active_days_target';

export type ReservedSeenMetric = typeof GROUP_RELEASE_METRIC | typeof ACTIVE_DAY_TARGET_METRIC;

// Reserved achievement_seen keys, kept out of SEEN_RETENTION_MS because they are not activity:
// group_release is the giveaway outcome a late entry reads, active_days_target the per-target
// copy of a day. They purge with the same rules, so both maps are merged there.
export const RESERVED_SEEN_RETENTION_MS: Record<ReservedSeenMetric, number | null> = {
  [GROUP_RELEASE_METRIC]: null,
  [ACTIVE_DAY_TARGET_METRIC]: SEEN_RETENTION_MS.active_days,
};
