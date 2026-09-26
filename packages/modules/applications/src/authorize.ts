import { type ApplicationStatus, hasWithAdmin, Permissions } from '@proton/core';
import { type ApplicationsConfig, type FormConfig, teamFor } from './config.ts';
import { allowedFrom, isFinal, STATUS_LABELS, type StaffAction } from './status.ts';

export const CAPABILITIES = ['view', 'review', 'decide', 'override', 'export', 'delete'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface ReviewActor {
  id: string;
  roleIds: readonly string[];
  permissions: bigint;
  owner: boolean;
}

type TeamConfig = Pick<
  ApplicationsConfig,
  | 'reviewerRoleIds'
  | 'deciderRoleIds'
  | 'viewerRoleIds'
  | 'overrideRoleIds'
  | 'exportRoleIds'
  | 'deleteRoleIds'
>;

type FormRef = Pick<FormConfig, 'name' | 'review'>;

export function isAdmin(actor: Pick<ReviewActor, 'owner' | 'permissions'>): boolean {
  return actor.owner || hasWithAdmin(actor.permissions, Permissions.ManageGuild);
}

function holdsAny(actor: Pick<ReviewActor, 'roleIds'>, roleIds: readonly string[]): boolean {
  if (roleIds.length === 0) return false;
  const wanted = new Set(roleIds);
  return actor.roleIds.some((roleId) => wanted.has(roleId));
}

export function capabilitiesFor(
  config: TeamConfig,
  form: FormRef,
  actor: ReviewActor,
): ReadonlySet<Capability> {
  if (isAdmin(actor)) return new Set(CAPABILITIES);

  const team = teamFor(config, form);
  const granted = new Set<Capability>();

  const decides = holdsAny(
    actor,
    team.deciderRoleIds.length > 0 ? team.deciderRoleIds : team.reviewerRoleIds,
  );
  const reviews = decides || holdsAny(actor, [...team.reviewerRoleIds, ...team.deciderRoleIds]);
  const views = reviews || holdsAny(actor, team.viewerRoleIds);

  if (views) granted.add('view');
  if (reviews) granted.add('review');
  if (decides) granted.add('decide');
  if (holdsAny(actor, config.overrideRoleIds)) granted.add('override');
  if (views && holdsAny(actor, config.exportRoleIds)) granted.add('export');
  if (holdsAny(actor, config.deleteRoleIds)) granted.add('delete');

  return granted;
}

export function viewableFormIds(
  config: TeamConfig & Pick<ApplicationsConfig, 'forms'>,
  actor: ReviewActor,
): string[] {
  return config.forms
    .filter((form) => capabilitiesFor(config, form, actor).has('view'))
    .map((form) => form.id);
}

const NEEDS: Readonly<Record<StaffAction, Capability>> = {
  claim: 'review',
  unclaim: 'review',
  assign: 'review',
  request_info: 'review',
  waitlist: 'review',
  note: 'review',
  vote: 'review',
  open_ticket: 'review',
  retry_effect: 'review',
  cancel_effect: 'review',
  repost_card: 'review',
  accept: 'decide',
  reject: 'decide',
  archive: 'decide',
  unarchive: 'decide',
  reopen: 'override',
  delete: 'delete',
};

export function capabilityFor(action: StaffAction): Capability {
  return NEEDS[action];
}

function missingCapability(capability: Capability, form: FormRef): string {
  switch (capability) {
    case 'view':
    case 'review':
      return `You aren’t on the review team for ${form.name}.`;
    case 'decide':
      return `Only deciders on the ${form.name} review team can do that.`;
    case 'override':
      return 'Reopening a decided application needs one of the reopen roles in Applications settings.';
    case 'export':
      return 'Downloading applications needs one of the export roles in Applications settings.';
    case 'delete':
      return 'Deleting an application needs one of the delete roles in Applications settings.';
  }
}

function statusRefusal(action: StaffAction, status: ApplicationStatus): string {
  if (status === 'withdrawn') return 'This application was withdrawn.';
  if (status === 'expired') return 'This application has expired.';
  if (status === 'draft') return 'This application hasn’t been sent yet.';

  switch (action) {
    case 'archive':
    case 'unarchive':
      return 'Only decided applications can be archived.';
    case 'reopen':
      return 'Only accepted or rejected applications can be reopened.';
    case 'unclaim':
      return 'Nobody has claimed this application.';
    case 'request_info':
      return status === 'needs_info'
        ? 'This application is already waiting for more information.'
        : 'This application has already been reviewed.';
    case 'waitlist':
      return status === 'waitlisted'
        ? 'This application is already waitlisted.'
        : 'This application has already been reviewed.';
    case 'vote':
      return 'Voting has closed on this application.';
    default:
      return isFinal(status)
        ? `This application has already been reviewed. It was ${STATUS_LABELS[status].toLowerCase()}.`
        : `This application is ${STATUS_LABELS[status].toLowerCase()}, so that can’t be done now.`;
  }
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; code: 'self' | 'not_allowed' | 'wrong_status'; humanReason: string };

export function authorizeAction(input: {
  config: TeamConfig;
  form: FormRef;
  actor: ReviewActor;
  application: { applicantId: string; status: ApplicationStatus; assigneeId: string | null };
  action: StaffAction;
}): AuthorizeResult {
  const { config, form, actor, application, action } = input;
  const capabilities = capabilitiesFor(config, form, actor);
  const needed = NEEDS[action];

  if (!capabilities.has(needed)) {
    const outsider = !capabilities.has('view') && (needed === 'review' || needed === 'decide');
    return {
      ok: false,
      code: 'not_allowed',
      humanReason: missingCapability(outsider ? 'view' : needed, form),
    };
  }

  if (application.applicantId === actor.id && action !== 'delete') {
    return {
      ok: false,
      code: 'self',
      humanReason: 'You can’t review your own application.',
    };
  }

  if (!allowedFrom(action).includes(application.status)) {
    return {
      ok: false,
      code: 'wrong_status',
      humanReason: statusRefusal(action, application.status),
    };
  }

  return { ok: true };
}

export function twoReviewerCheck(input: {
  form: Pick<FormConfig, 'name' | 'review'>;
  decision: 'accept' | 'reject';
  deciderId: string;
  votes: readonly { reviewerId: string; vote: 'accept' | 'reject' }[];
  applicantId: string;
}): { ok: true } | { ok: false; humanReason: string } {
  const { form, decision, deciderId, votes, applicantId } = input;
  if (!form.review.requireTwoReviewers) return { ok: true };

  const seconded = votes.some(
    (vote) =>
      vote.vote === decision && vote.reviewerId !== deciderId && vote.reviewerId !== applicantId,
  );
  if (seconded) return { ok: true };

  const verb = decision === 'accept' ? 'accept' : 'reject';
  return {
    ok: false,
    humanReason:
      `${form.name} needs two reviewers to agree. Ask another reviewer to vote to ${verb} ` +
      'first.',
  };
}
