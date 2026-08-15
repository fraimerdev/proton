import type { ActionKind } from '@proton/core';
import type { AntiraidConfig, RaidResponse } from './config.ts';
import { MAX_JOIN_SCORE, type RaidScore } from './score.ts';

/** Discord truncates an audit-log reason past this, and `ActionRequest` refuses it. */
export const MAX_REASON_LENGTH = 512;

/** How each rung reads in the raid alert, as the predicate of "joins … are". */
export const RESPONSE_LABELS: Record<RaidResponse, string> = {
  verify: 'being given the verification role',
  quarantine: 'being quarantined for staff review',
  kick: 'being kicked',
};

/** Which setting names the role each rung applies, for the message that asks for it. */
const RESPONSE_ROLE_SETTINGS: Record<RaidResponse, string | null> = {
  verify: 'a verification role',
  quarantine: 'a quarantine role',
  kick: null,
};

export interface ResponsePlan {
  kind: ActionKind;
  payload: Record<string, unknown>;
  /** What Discord shows beside the action in the guild's own audit log. */
  reason: string;
}

/**
 * Either what to do, or a sentence naming what is missing and where to set it.
 *
 * Never a bare null. A rung whose role was never configured is the "the bot did
 * nothing" outcome §1 exists to kill, and the only useful thing to say about it
 * names the setting and the page it lives on.
 */
export type ResponsePlanResult = { plan: ResponsePlan } | { unconfigured: string };

const DASHBOARD = 'the Anti-raid page of the Proton dashboard';

/** The action kind each rung performs. */
export function responseKind(response: RaidResponse): ActionKind {
  return response === 'kick' ? 'kick' : 'add_role';
}

/** The role the configured rung applies; undefined for a rung that needs none. */
function responseRoleId(config: AntiraidConfig): string | undefined {
  switch (config.response) {
    case 'verify':
      return config.verificationRoleId;
    case 'quarantine':
      return config.quarantineRoleId;
    case 'kick':
      return undefined;
  }
}

/**
 * Why this guild's chosen rung cannot run, if it cannot.
 *
 * Exported because the raid alert needs the same answer the planner does: an
 * admin watching a raid must be told that the response they picked is inert,
 * and finding that out from a log line nobody is reading is the same as not
 * being told.
 */
export function responseUnconfigured(config: AntiraidConfig): string | null {
  const setting = RESPONSE_ROLE_SETTINGS[config.response];
  if (setting === null || responseRoleId(config) !== undefined) return null;

  return (
    `The ${config.response} response has no role configured, so Proton cannot act on the ` +
    `accounts it flags. Set ${setting} on ${DASHBOARD}, or change the response to one that ` +
    'needs no role.'
  );
}

/**
 * Build the action for the rung this guild opted into.
 *
 * The module never picks a harsher rung than the configured one — see the note
 * on `RAID_RESPONSES`. What varies with the score is *whether* to act, not how
 * hard, so a scoring mistake costs a member a role they did not need rather than
 * a removal nobody authorised.
 */
export function planResponse(
  config: AntiraidConfig,
  userId: string,
  score: RaidScore,
): ResponsePlanResult {
  const unconfigured = responseUnconfigured(config);
  if (unconfigured) return { unconfigured };

  const roleId = responseRoleId(config);

  return {
    plan: {
      // Kick, never ban. A raid account that rejoins is screened again; a member
      // banned by a false positive needs a human to notice and undo it.
      kind: responseKind(config.response),
      payload: roleId === undefined ? { userId } : { userId, roleId },
      reason: `Anti-raid ${score.score}/${MAX_JOIN_SCORE}: ${score.reasons.join(' ')}`.slice(
        0,
        MAX_REASON_LENGTH,
      ),
    },
  };
}
