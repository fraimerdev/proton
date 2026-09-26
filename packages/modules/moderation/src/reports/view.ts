import {
  jsonValueSchema,
  REPORT_ACTIONS,
  reportActionOutcomeSchema,
  reportActionParamsSchema,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';
import {
  AUTOMATION_RUN_STATUSES,
  attachmentMetaSchema,
  automationRunSchema,
  reportEventRecordSchema,
  reportRecordSchema,
} from './types.ts';

export const REPORT_QUERY_STATUSES = [
  'active',
  'open',
  'in_review',
  'accepted',
  'dismissed',
  'resolved',
  'all',
] as const;
export type ReportQueryStatus = (typeof REPORT_QUERY_STATUSES)[number];

export const REPORT_SORTS = ['created', 'number', 'volume'] as const;
export type ReportSort = (typeof REPORT_SORTS)[number];

export const REPORT_SORT_DIRECTIONS = ['asc', 'desc'] as const;

export const REPORT_PAGE_SIZE_DEFAULT = 25;
export const REPORT_PAGE_SIZE_MAX = 30;
export const REPORT_GROUP_PREVIEW = 5;
export const REPORT_RELATED_MAX = 20;

function blankless<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const instant = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

function page(max: number, fallback: number) {
  return {
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(max).default(fallback),
  };
}

export const reportQuerySchema = z
  .object({
    status: z.enum(REPORT_QUERY_STATUSES).default('active'),
    targetId: blankless(snowflakeSchema),
    reporterId: blankless(snowflakeSchema),
    assigneeId: blankless(z.union([snowflakeSchema, z.literal('none')])),
    from: blankless(instant),
    to: blankless(instant),
    q: blankless(z.string().trim().min(1).max(100)),
    delivery: blankless(z.enum(['problem'])),
    sort: z.enum(REPORT_SORTS).default('created'),
    dir: z.enum(REPORT_SORT_DIRECTIONS).default('desc'),
    ...page(REPORT_PAGE_SIZE_MAX, REPORT_PAGE_SIZE_DEFAULT),
    group: blankless(z.enum(['member'])),
  })
  .refine((query) => query.sort !== 'volume' || query.group === 'member', {
    message: 'sorting by volume ranks members, so it needs group=member',
    path: ['sort'],
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.from) <= Date.parse(query.to),
    { message: 'the start date must be on or before the end date', path: ['from'] },
  );

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type ReportQueryInput = z.input<typeof reportQuerySchema>;

export const reportSummarySchema = reportRecordSchema.pick({
  id: true,
  number: true,
  status: true,
  method: true,
  reporterId: true,
  targetId: true,
  reasonId: true,
  reason: true,
  customReason: true,
  sourceChannelId: true,
  sourceMessageId: true,
  assigneeId: true,
  assignedAt: true,
  resolvedBy: true,
  resolvedAt: true,
  actionKind: true,
  caseIds: true,
  card: true,
  close: true,
  evidencePurgedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const reportGroupSchema = z.object({
  targetId: z.string(),
  total: z.number().int(),
  open: z.number().int(),
  distinctReporters: z.number().int(),
  firstAt: z.number(),
  lastAt: z.number(),
  reports: z.array(reportSummarySchema).max(REPORT_GROUP_PREVIEW),
});

export type ReportGroup = z.infer<typeof reportGroupSchema>;

const paging = {
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
};

export const reportListResultSchema = z.discriminatedUnion('grouped', [
  z.object({ grouped: z.literal(false), reports: z.array(reportSummarySchema), ...paging }),
  z.object({ grouped: z.literal(true), groups: z.array(reportGroupSchema), ...paging }),
]);

export type ReportListResult = z.infer<typeof reportListResultSchema>;

export const reportEventViewSchema = reportEventRecordSchema
  .omit({ guildId: true })
  .extend({ data: z.record(z.string(), jsonValueSchema) });
export type ReportEventView = z.infer<typeof reportEventViewSchema>;

export const reportCaseSchema = z.object({
  id: z.string(),
  caseNumber: z.number().int(),
  type: z.string(),
  actorId: z.string().nullable(),
  targetId: z.string().nullable(),
  moderatorId: z.string().nullable(),
  reason: z.string().nullable(),
  moduleId: z.string(),
  expiresAt: z.string().nullable(),
  revertedAt: z.string().nullable(),
  revertedBy: z.string().nullable(),
  dryRun: z.boolean(),
  createdAt: z.string(),
});

export type ReportCase = z.infer<typeof reportCaseSchema>;

export const reportTargetStatsSchema = z.object({
  total: z.number().int(),
  distinctReporters: z.number().int(),
  open: z.number().int(),
});

export const reportDetailSchema = reportRecordSchema
  .omit({ idempotencyKey: true, decision: true, dmChannelId: true, dmAttempts: true })
  .extend({
    deciding: z.boolean(),
    events: z.array(reportEventViewSchema),
    related: z.array(reportSummarySchema).max(REPORT_RELATED_MAX),
    cases: z.array(reportCaseSchema),
    stats: reportTargetStatsSchema,
  });

export type ReportDetail = z.infer<typeof reportDetailSchema>;

const count = z.number().int().min(0);

export const reportSummaryCountsSchema = z.object({
  counts: z.object({ open: count, in_review: count, accepted: count, dismissed: count }),
  openUnclaimed: count,
  oldestOpenAt: z.number().nullable(),
  deliveryProblems: count,
  closeProblems: count,
  automationFailures7d: count,
});

export type ReportSummaryCounts = z.infer<typeof reportSummaryCountsSchema>;

export const automationRunViewSchema = automationRunSchema.omit({
  guildId: true,
  leaseUntil: true,
});

export type AutomationRunView = z.infer<typeof automationRunViewSchema>;

export const automationRunQuerySchema = z.object({
  status: blankless(z.enum(AUTOMATION_RUN_STATUSES)),
  ...page(REPORT_PAGE_SIZE_MAX, REPORT_PAGE_SIZE_DEFAULT),
});

export type AutomationRunQuery = z.infer<typeof automationRunQuerySchema>;

export const automationRunListSchema = z.object({
  runs: z.array(automationRunViewSchema),
  ...paging,
});

export type AutomationRunList = z.infer<typeof automationRunListSchema>;

export const caseMessageViewSchema = z.object({
  caseId: z.string(),
  messageId: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  content: z.string(),
  attachments: z.array(attachmentMetaSchema),
  createdAt: z.number(),
  deletedAt: z.number().nullable(),
  proof: z.boolean(),
  capturedAt: z.number(),
  expiresAt: z.number(),
});

export type CaseMessageView = z.infer<typeof caseMessageViewSchema>;

export const caseEvidenceViewSchema = z.object({
  proof: caseMessageViewSchema.nullable(),
  history: z.array(caseMessageViewSchema),
});

export type CaseEvidenceView = z.infer<typeof caseEvidenceViewSchema>;

export const REPORT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const reportActionBodySchema = z.object({
  action: z.enum(REPORT_ACTIONS),
  params: reportActionParamsSchema.default({}),
  requestId: z.string().regex(REPORT_REQUEST_ID),
  actorId: snowflakeSchema,
  actorPermissions: z.string().regex(/^\d+$/),
  source: z.literal('dashboard'),
  ipHash: z.string().min(1).max(128).optional(),
});

export type ReportActionBody = z.infer<typeof reportActionBodySchema>;

export const reportActionResultSchema = reportActionOutcomeSchema;
export type ReportActionResult = z.infer<typeof reportActionResultSchema>;
