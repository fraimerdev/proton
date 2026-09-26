import { hasWithAdmin, Permissions, type ReportAction } from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import type { ReportRecord } from './types.ts';

export interface ReporterFacts {
  id: string;
  roleIds: string[] | null;
  permissions: bigint | null;
}

export interface TargetFacts {
  reporterId: string;
  targetId: string;
  targetBot: boolean;
  // null is someone who is not in the server, and holds no role that could exempt them.
  targetRoleIds: string[] | null;
}

export const INTAKE_REFUSAL_CODES = [
  'blocked',
  'not_allowed',
  'roles_unknown',
  'self',
  'bot',
  'immune',
] as const;

export type IntakeRefusalCode = (typeof INTAKE_REFUSAL_CODES)[number];

export type IntakeCheck = { ok: true } | { ok: false; code: IntakeRefusalCode; message: string };

const PASS: IntakeCheck = { ok: true };

function refuse(code: IntakeRefusalCode, message: string): IntakeCheck {
  return { ok: false, code, message };
}

function holdsAny(roleIds: readonly string[], listed: readonly string[], guildId: string): boolean {
  return listed.some((roleId) => roleId === guildId || roleIds.includes(roleId));
}

export function validateReporter(
  config: ModerationConfig,
  reporter: ReporterFacts,
  guildId: string,
): IntakeCheck {
  const reports = config.reports;

  if (reports.blockedUserIds.includes(reporter.id)) {
    return refuse('blocked', 'Staff in this server have blocked you from filing reports.');
  }

  const mode = reports.reporters.mode;
  if (mode === 'everyone') return PASS;

  if (
    reporter.permissions !== null &&
    hasWithAdmin(reporter.permissions, Permissions.Administrator)
  ) {
    return PASS;
  }

  if (reporter.roleIds === null) {
    return refuse(
      'roles_unknown',
      'I couldn’t check your roles, so nothing was filed. Try again in a moment.',
    );
  }

  const listed = holdsAny(reporter.roleIds, reports.reporters.roleIds, guildId);

  if (mode === 'only' && !listed) {
    return refuse(
      'not_allowed',
      'Only members with certain roles can file reports in this server.',
    );
  }

  if (mode === 'except' && listed) {
    return refuse(
      'not_allowed',
      'Members with one of your roles can’t file reports in this server.',
    );
  }

  return PASS;
}

export function validateTarget(config: ModerationConfig, target: TargetFacts): IntakeCheck {
  if (target.targetId === target.reporterId) {
    return refuse('self', 'You can’t report yourself.');
  }

  if (target.targetBot) {
    return refuse('bot', 'Bots can’t be reported. Report the member who used the bot instead.');
  }

  const immune = config.reports.immuneRoleIds;
  if (target.targetRoleIds?.some((id) => immune.includes(id))) {
    return refuse('immune', `Staff have made <@${target.targetId}> exempt from reports here.`);
  }

  return PASS;
}

export interface ReviewActor {
  id: string;
  roleIds: string[] | null;
  permissions: bigint;
  source: 'discord' | 'dashboard';
  owner?: boolean;
}

export type ReviewAction = ReportAction | 'view';

export type ReviewCheck = { ok: true } | { ok: false; message: string };

const DECIDING: ReadonlySet<ReviewAction> = new Set(['accept', 'dismiss']);

function isAdmin(actor: ReviewActor): boolean {
  return actor.owner === true || hasWithAdmin(actor.permissions, Permissions.ManageGuild);
}

export function mayReview(
  config: ModerationConfig,
  actor: ReviewActor,
  report: Pick<ReportRecord, 'targetId' | 'reporterId'>,
  action: ReviewAction = 'view',
): ReviewCheck {
  if (actor.id === report.targetId) {
    return { ok: false, message: 'You can’t review a report about yourself.' };
  }

  const reviewer =
    isAdmin(actor) ||
    (actor.roleIds ?? []).some((roleId) => config.reports.reviewerRoleIds.includes(roleId));

  if (!reviewer) {
    return {
      ok: false,
      message:
        'Reviewing reports needs Manage Server or one of the reviewer roles set in the Proton ' +
        'dashboard under Moderation → User reports.',
    };
  }

  if (DECIDING.has(action) && actor.id === report.reporterId && actor.owner !== true) {
    return {
      ok: false,
      message: 'You filed this report, so someone else on staff has to accept or dismiss it.',
    };
  }

  return { ok: true };
}

export function mayUnclaim(
  report: Pick<ReportRecord, 'assigneeId'>,
  actor: ReviewActor,
): ReviewCheck {
  if (report.assigneeId === actor.id || isAdmin(actor)) return { ok: true };

  return {
    ok: false,
    message:
      report.assigneeId === null
        ? 'Nobody has claimed this report.'
        : `Only <@${report.assigneeId}> or someone with Manage Server can unclaim this report.`,
  };
}
