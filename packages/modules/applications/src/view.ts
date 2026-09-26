import { APPLICATION_STATUSES, componentEmojiSchema, snowflakeSchema } from '@proton/core';
import { z } from 'zod';
import { CAPABILITIES } from './authorize.ts';
import { slug } from './config.ts';
import {
  FORM_ID_MAX,
  INFO_REQUEST_MAX,
  INFO_RESPONSE_MAX,
  NOTE_MAX,
  REASON_MAX,
} from './constants.ts';
import { eligibilitySchema, requirementIssueSchema } from './eligibility.ts';
import { intakeStateSchema } from './intake.ts';
import { answerProblemSchema, checkedAnswerSchema, draftAnswersSchema } from './questions.ts';
import { formSnapshotSchema } from './version.ts';

export { CAPABILITIES, type Capability } from './authorize.ts';
export {
  type Eligibility,
  eligibilitySchema,
  type RequirementIssue,
  type RequirementLine,
} from './eligibility.ts';
export { type IntakeState, intakeStateSchema } from './intake.ts';
export { type FormSnapshot, formSnapshotSchema } from './version.ts';

export const EFFECT_KINDS = [
  'card',
  'ping',
  'dm',
  'add_role',
  'remove_role',
  'xp',
  'ticket',
  'event',
  'reminder',
  'delete_card',
] as const;
type EffectKind = (typeof EFFECT_KINDS)[number];

export const EFFECT_STATUSES = [
  'pending',
  'running',
  'requested',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;

export const EFFECT_LABELS: Readonly<Record<EffectKind, string>> = {
  card: 'Review card',
  ping: 'Review ping',
  dm: 'DM to the applicant',
  add_role: 'Add role',
  remove_role: 'Remove role',
  xp: 'XP reward',
  ticket: 'Interview ticket',
  event: 'Update for other modules',
  reminder: 'Review reminder',
  delete_card: 'Remove review card',
};

export const EFFECT_PROBLEM_LABELS: Readonly<Record<EffectKind, string>> = {
  card: 'Card not posted',
  ping: 'Ping not sent',
  dm: 'DM not delivered',
  add_role: 'Role update failed',
  remove_role: 'Role update failed',
  xp: 'XP not given',
  ticket: 'Ticket not opened',
  event: 'Update not sent',
  reminder: 'Reminder not posted',
  delete_card: 'Card not removed',
};

export const QUEUE_VIEWS = [
  'awaiting',
  'needs_info',
  'waitlisted',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
  'all',
  'archived',
] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export const QUEUE_SORTS = ['submitted', 'number', 'updated'] as const;
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;

export const THREAD_KINDS = ['info_request', 'info_response', 'decision', 'reopened'] as const;
export const EVENT_SOURCES = ['discord', 'dashboard', 'web', 'system'] as const;
export const DRAFT_POLICIES = ['keep', 'restart'] as const;
export const VOTES = ['accept', 'reject'] as const;

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const requestIdSchema = z.string().regex(REQUEST_ID);

const status = z.enum(APPLICATION_STATUSES);
const instant = z.number();
const count = z.number().int().min(0);

function blankless<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

export const auditStampSchema = z.object({
  actorId: snowflakeSchema,
  source: z.literal('dashboard'),
  ipHash: z.string().min(1).max(128).optional(),
});
export type AuditStamp = z.infer<typeof auditStampSchema>;

export const publishedVersionSchema = z.object({
  versionId: z.string(),
  version: z.number().int().min(1),
  publishedAt: instant,
  publishedBy: z.string(),
});

export const formOverviewSchema = z.object({
  forms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      emoji: componentEmojiSchema.optional(),
      archived: z.boolean(),
      intake: intakeStateSchema,
      published: publishedVersionSchema.nullable(),
      draftChanged: z.boolean(),
      publishIssues: z.array(z.string()),
      requirementIssues: z.array(requirementIssueSchema),
      counts: z.object({ awaiting: count, needsInfo: count, drafts: count, total: count }),
    }),
  ),
  retiredFormIds: z.array(z.string()).default([]),
});
export type FormOverview = z.infer<typeof formOverviewSchema>;

export const publishBodySchema = z.object({
  requestId: requestIdSchema,
  draftPolicy: z.enum(DRAFT_POLICIES).default('keep'),
  ...auditStampSchema.shape,
});
export type PublishBody = z.infer<typeof publishBodySchema>;

export const publishResultSchema = z.object({
  status: z.enum(['published', 'unchanged']),
  version: z.number().int().min(1),
  versionId: z.string(),
  draftsExpired: count,
});
export type PublishResult = z.infer<typeof publishResultSchema>;

export const versionMetaSchema = z.object({
  id: z.string(),
  formId: z.string(),
  version: z.number().int().min(1),
  draftPolicy: z.enum(DRAFT_POLICIES),
  publishedBy: z.string(),
  publishedAt: instant,
});
export type VersionMeta = z.infer<typeof versionMetaSchema>;

export const versionListSchema = z.object({ versions: z.array(versionMetaSchema) });
export type VersionList = z.infer<typeof versionListSchema>;

export const versionSchema = versionMetaSchema.extend({ snapshot: formSnapshotSchema });
export type VersionView = z.infer<typeof versionSchema>;

export const queueQuerySchema = z.object({
  view: z.enum(QUEUE_VIEWS).default('awaiting'),
  formId: blankless(slug(FORM_ID_MAX)),
  assignee: blankless(z.union([snowflakeSchema, z.enum(['me', 'none'])])),
  q: blankless(z.string().trim().min(1).max(100)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
  sort: z.enum(QUEUE_SORTS).default('submitted'),
  dir: z.enum(SORT_DIRECTIONS).default('desc'),
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;
export type QueueQueryInput = z.input<typeof queueQuerySchema>;

export const effectProblemSchema = z.object({
  effectId: z.string(),
  kind: z.enum(EFFECT_KINDS),
  label: z.string(),
});
export type EffectProblem = z.infer<typeof effectProblemSchema>;

export const queueItemSchema = z.object({
  id: z.string(),
  number: z.number().int().min(1).nullable(),
  formId: z.string(),
  formName: z.string(),
  applicantId: z.string(),
  applicantName: z.string().nullable(),
  status,
  assigneeId: z.string().nullable(),
  submittedAt: instant.nullable(),
  updatedAt: instant,
  archived: z.boolean(),
  problems: z.array(effectProblemSchema),
  votes: z.object({ accept: count, reject: count }),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueResultSchema = z.object({
  items: z.array(queueItemSchema),
  total: count,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type QueueResult = z.infer<typeof queueResultSchema>;

export const queueSummarySchema = z.object({
  awaiting: count,
  unassigned: count,
  needsInfo: count,
  waitlisted: count,
  problems: count,
  oldestAwaitingAt: instant.nullable(),
});
export type QueueSummary = z.infer<typeof queueSummarySchema>;

export const effectViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(EFFECT_KINDS),
  status: z.enum(EFFECT_STATUSES),
  attempts: count,
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
  updatedAt: instant,
  label: z.string(),
});
export type EffectView = z.infer<typeof effectViewSchema>;

export const threadEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(THREAD_KINDS),
  authorId: z.string(),
  body: z.string().nullable(),
  createdAt: instant,
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

export const applicationDetailSchema = z.object({
  application: queueItemSchema.extend({
    versionId: z.string(),
    version: z.number().int().min(1),
    decidedAt: instant.nullable(),
    decidedBy: z.string().nullable(),
    decisionReason: z.string().nullable(),
    reopenedCount: count,
    archivedAt: instant.nullable(),
    contentPurgedAt: instant.nullable(),
    deletedAt: instant.nullable(),
    interview: z
      .object({
        ticketId: z.string(),
        channelId: z.string().nullable(),
        status: z.enum(['open', 'closed', 'unknown']),
      })
      .nullable(),
    cardUrl: z.string().nullable(),
  }),
  answers: z.array(checkedAnswerSchema).nullable(),
  sections: z.array(z.object({ id: z.string(), title: z.string() })),
  thread: z.array(threadEntrySchema),
  notes: z
    .array(
      z.object({
        id: z.string(),
        authorId: z.string(),
        body: z.string().nullable(),
        createdAt: instant,
      }),
    )
    .nullable(),
  votes: z
    .array(
      z.object({
        reviewerId: z.string(),
        vote: z.enum(VOTES),
        score: z.number().int().min(1).max(5).nullable(),
        updatedAt: instant,
      }),
    )
    .nullable(),
  history: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      actorId: z.string(),
      source: z.enum(EVENT_SOURCES),
      fromStatus: status.nullable(),
      toStatus: status.nullable(),
      createdAt: instant,
    }),
  ),
  effects: z.array(effectViewSchema),
  capabilities: z.array(z.enum(CAPABILITIES)),
  moderation: z
    .object({
      activeCases: count,
      recent: z.array(
        z.object({
          caseNumber: z.number().int(),
          type: z.string(),
          createdAt: instant,
          reason: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  twoReviewers: z.boolean(),
  scoring: z.boolean(),
});
export type ApplicationDetail = z.infer<typeof applicationDetailSchema>;

const decisionParams = {
  reason: z.string().trim().max(REASON_MAX).optional(),
  note: z.string().trim().max(NOTE_MAX).optional(),
  override: z.boolean().optional(),
};

const staffCommon = { requestId: requestIdSchema, ...auditStampSchema.shape };

const effectId = z.string().min(1).max(64);

export const staffActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim'), ...staffCommon }),
  z.object({ action: z.literal('unclaim'), ...staffCommon }),
  z.object({ action: z.literal('assign'), assigneeId: snowflakeSchema.nullable(), ...staffCommon }),
  z.object({
    action: z.literal('note'),
    body: z.string().trim().min(1).max(NOTE_MAX),
    ...staffCommon,
  }),
  z.object({
    action: z.literal('vote'),
    vote: z.enum(VOTES),
    score: z.number().int().min(1).max(5).optional(),
    ...staffCommon,
  }),
  z.object({
    action: z.literal('request_info'),
    message: z.string().trim().min(1).max(INFO_REQUEST_MAX),
    ...staffCommon,
  }),
  z.object({
    action: z.literal('waitlist'),
    reason: z.string().trim().max(REASON_MAX).optional(),
    ...staffCommon,
  }),
  z.object({ action: z.literal('accept'), ...decisionParams, ...staffCommon }),
  z.object({ action: z.literal('reject'), ...decisionParams, ...staffCommon }),
  z.object({
    action: z.literal('reopen'),
    reason: z.string().trim().min(1).max(REASON_MAX),
    ...staffCommon,
  }),
  z.object({ action: z.literal('archive'), ...staffCommon }),
  z.object({ action: z.literal('unarchive'), ...staffCommon }),
  z.object({ action: z.literal('open_ticket'), ...staffCommon }),
  z.object({ action: z.literal('retry_effect'), effectId, ...staffCommon }),
  z.object({ action: z.literal('cancel_effect'), effectId, ...staffCommon }),
  z.object({ action: z.literal('repost_card'), ...staffCommon }),
  z.object({ action: z.literal('delete'), confirm: z.literal(true), ...staffCommon }),
]);
export type StaffActionBody = z.infer<typeof staffActionSchema>;

export const staffActionResultSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
  application: queueItemSchema.nullable(),
});
export type StaffActionResult = z.infer<typeof staffActionResultSchema>;

export const portalDraftSchema = z.object({
  id: z.string(),
  revision: count,
  answers: draftAnswersSchema,
  updatedAt: instant,
  versionId: z.string(),
  stale: z.boolean(),
});

export const portalFormSchema = z.object({
  guild: z.object({ id: z.string(), name: z.string(), iconUrl: z.string().nullable() }),
  form: formSnapshotSchema.extend({ id: z.string() }),
  versionId: z.string(),
  intake: intakeStateSchema,
  intakeSentence: z.string(),
  whoCanRead: z.string(),
  eligibility: eligibilitySchema,
  draft: portalDraftSchema.nullable(),
  active: z.array(z.object({ id: z.string(), number: z.number().int().nullable(), status })),
});
export type PortalForm = z.infer<typeof portalFormSchema>;

export const draftSaveBodySchema = z.object({
  userId: snowflakeSchema,
  answers: draftAnswersSchema,
  expectedRevision: z.number().int().min(0).nullable(),
  requestId: requestIdSchema,
  versionId: z.string().min(1).max(64).optional(),
});
export type DraftSaveBody = z.infer<typeof draftSaveBodySchema>;

export const draftSaveResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), revision: count, savedAt: instant }),
  z.object({
    status: z.literal('conflict'),
    draft: z.object({ revision: count, answers: draftAnswersSchema, updatedAt: instant }),
  }),
  z.object({ status: z.literal('refused'), message: z.string() }),
]);
export type DraftSaveResult = z.infer<typeof draftSaveResultSchema>;

export const portalSubmitBodySchema = z.object({
  userId: snowflakeSchema,
  expectedRevision: z.number().int().min(0),
  requestId: requestIdSchema,
});
export type PortalSubmitBody = z.infer<typeof portalSubmitBodySchema>;

export const portalSubmitResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('submitted'),
    applicationId: z.string(),
    number: z.number().int().min(1),
  }),
  z.object({ status: z.literal('invalid'), problems: z.array(answerProblemSchema) }),
  z.object({ status: z.literal('refused'), message: z.string() }),
  z.object({ status: z.literal('conflict'), revision: count }),
]);
export type PortalSubmitResult = z.infer<typeof portalSubmitResultSchema>;

export const portalApplicationSchema = z.object({
  id: z.string(),
  number: z.number().int().min(1).nullable(),
  guildId: z.string(),
  formId: z.string(),
  formName: z.string(),
  status,
  statusLabel: z.string(),
  submittedAt: instant.nullable(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  answers: z.array(checkedAnswerSchema).nullable(),
  thread: z.array(
    threadEntrySchema.extend({ kind: z.enum(['info_request', 'info_response', 'decision']) }),
  ),
  canWithdraw: z.boolean(),
  canRespond: z.boolean(),
  confirmation: z.string(),
});
export type PortalApplication = z.infer<typeof portalApplicationSchema>;

export const myApplicationsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      number: z.number().int().min(1).nullable(),
      guildId: z.string(),
      formId: z.string(),
      formName: z.string(),
      status,
      statusLabel: z.string(),
      submittedAt: instant.nullable(),
      updatedAt: instant,
    }),
  ),
});
export type MyApplications = z.infer<typeof myApplicationsSchema>;

export const portalRespondBodySchema = z.object({
  userId: snowflakeSchema,
  message: z.string().trim().min(1).max(INFO_RESPONSE_MAX),
  requestId: requestIdSchema,
});
export type PortalRespondBody = z.infer<typeof portalRespondBodySchema>;

export const portalWithdrawBodySchema = z.object({
  userId: snowflakeSchema,
  requestId: requestIdSchema,
});
export type PortalWithdrawBody = z.infer<typeof portalWithdrawBodySchema>;

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  formId: blankless(slug(FORM_ID_MAX)),
  view: z.enum(QUEUE_VIEWS).default('all'),
  from: blankless(z.coerce.number().int().min(0)),
  to: blankless(z.coerce.number().int().min(0)),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const eligibilityPreviewBodySchema = z.object({ userId: snowflakeSchema });
export type EligibilityPreviewBody = z.infer<typeof eligibilityPreviewBodySchema>;

export const eligibilityPreviewSchema = z.object({
  member: z.enum(['member', 'absent', 'unavailable']),
  eligibility: eligibilitySchema.nullable(),
  checked: z.enum(['published', 'saved']).optional(),
});
export type EligibilityPreview = z.infer<typeof eligibilityPreviewSchema>;

export const audienceSchema = z.object({
  channelId: z.string(),
  everyone: z.boolean(),
  roleIds: z.array(z.string()),
  administratorRoleIds: z.array(z.string()),
  memberCount: count,
  outsideTeam: z.array(z.string()),
});
export type Audience = z.infer<typeof audienceSchema>;

export const reviewMembersSchema = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      username: z.string(),
      avatarUrl: z.string().nullable(),
      bot: z.boolean(),
    }),
  ),
});
export type ReviewMembers = z.infer<typeof reviewMembersSchema>;

export const deleteApplicantBodySchema = z.object({
  confirm: z.literal(true),
  ...staffCommon,
});
export type DeleteApplicantBody = z.infer<typeof deleteApplicantBodySchema>;

export const deleteApplicantResultSchema = z.object({ deleted: count });
export type DeleteApplicantResult = z.infer<typeof deleteApplicantResultSchema>;

export const portalGuildSchema = z.object({
  guild: portalFormSchema.shape.guild,
  moduleOn: z.boolean(),
  forms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      emoji: componentEmojiSchema.optional(),
      intake: intakeStateSchema,
      intakeSentence: z.string(),
      draft: z.object({ id: z.string(), updatedAt: instant }).nullable(),
    }),
  ),
  applications: myApplicationsSchema.shape.items,
});
export type PortalGuild = z.infer<typeof portalGuildSchema>;

export const portalDiscardResultSchema = z.object({ discarded: z.boolean() });
export type PortalDiscardResult = z.infer<typeof portalDiscardResultSchema>;
