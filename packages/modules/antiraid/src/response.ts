import type { ActionKind } from '@proton/core';
import type { AntiraidConfig, RaidResponse } from './config.ts';
import { MAX_JOIN_SCORE, type RaidScore } from './score.ts';

export const MAX_REASON_LENGTH = 512;

export const RESPONSE_LABELS: Record<RaidResponse, string> = {
  verify: 'being given the verification role',
  quarantine: 'being quarantined for staff review',
  kick: 'being kicked',
};

const RESPONSE_ROLE_SETTINGS: Record<RaidResponse, string | null> = {
  verify: 'a verification role',
  quarantine: 'a quarantine role',
  kick: null,
};

export interface ResponsePlan {
  kind: ActionKind;
  payload: Record<string, unknown>;

  reason: string;
}

export type ResponsePlanResult = { plan: ResponsePlan } | { unconfigured: string };

const DASHBOARD = 'the Anti-raid page of the Proton dashboard';

export function responseKind(response: RaidResponse): ActionKind {
  return response === 'kick' ? 'kick' : 'add_role';
}

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

export function responseUnconfigured(config: AntiraidConfig): string | null {
  const setting = RESPONSE_ROLE_SETTINGS[config.response];
  if (setting === null || responseRoleId(config) !== undefined) return null;

  return (
    `The ${config.response} response has no role configured, so Proton cannot act on the ` +
    `accounts it flags. Set ${setting} on ${DASHBOARD}, or change the response to one that ` +
    'needs no role.'
  );
}

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
      kind: responseKind(config.response),
      payload: roleId === undefined ? { userId } : { userId, roleId },
      reason: `Anti-raid ${score.score}/${MAX_JOIN_SCORE}: ${score.reasons.join(' ')}`.slice(
        0,
        MAX_REASON_LENGTH,
      ),
    },
  };
}
