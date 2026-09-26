import { REPORT_METHODS, REPORT_STATUSES, type ReportStatus } from '@proton/core';
import { z } from 'zod';

export {
  REPORT_METHODS,
  REPORT_STATUSES,
  type ReportMethod,
  type ReportStatus,
} from '@proton/core';

export const REPORT_COMMAND = 'report';

export const ACTIVE_REPORT_STATUSES = ['open', 'in_review'] as const satisfies ReportStatus[];
export const RESOLVED_REPORT_STATUSES = ['accepted', 'dismissed'] as const satisfies ReportStatus[];

export type ResolvedReportStatus = (typeof RESOLVED_REPORT_STATUSES)[number];

export function isActiveStatus(status: ReportStatus): boolean {
  return status === 'open' || status === 'in_review';
}

export const CARD_STATES = [
  'pending',
  'posted',
  'failed',
  'missing',
  'moved',
  'deleted',
  'closing',
] as const;
export type CardState = (typeof CARD_STATES)[number];

export const CLOSE_ACTIONS = ['move', 'delete'] as const;
export type CloseAction = (typeof CLOSE_ACTIONS)[number];

export const NOTIFICATION_KINDS = ['submitted', 'accepted', 'dismissed'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_OUTCOMES = [
  'sent',
  'closed',
  'no_mutual_server',
  'failed',
  'gave_up',
  'skipped',
] as const;
export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

export const REPORT_EVENT_KINDS = [
  'submitted',
  'claimed',
  'unclaimed',
  'assigned',
  'accepted',
  'dismissed',
  'action_executed',
  'action_failed',
  'delivery_failed',
  'delivered',
  'card_missing',
  'reposted',
  'moved',
  'deleted',
  'close_failed',
  'notified',
  'notification_failed',
  'automation_fired',
  'evidence_purged',
] as const;
export type ReportEventKind = (typeof REPORT_EVENT_KINDS)[number];

export const REPORT_EVENT_SOURCES = ['discord', 'dashboard', 'automation', 'system'] as const;
export type ReportEventSource = (typeof REPORT_EVENT_SOURCES)[number];

export const AUTOMATION_RUN_STATUSES = [
  'running',
  'done',
  'partial',
  'failed',
  'cancelled',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const REPORT_REFUSAL_CODES = ['cooldown', 'duplicate', 'member_cap', 'server_cap'] as const;
export type ReportRefusalCode = (typeof REPORT_REFUSAL_CODES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export const EVIDENCE_OPEN_TTL_MS = 90 * DAY_MS;
export const EVIDENCE_RESOLVED_TTL_MS = 30 * DAY_MS;

export const STORED_CONTENT_MAX = 4000;
export const REPORT_LINKS_MAX = 3;
export const EMBED_TEXT_STORED_MAX = 256;

export const attachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string().nullable().default(null),
  size: z.number().default(0),
  url: z.string(),
  expiresAt: z.number().nullable().default(null),
});

export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

export const SNAPSHOT_SOURCES = ['interaction', 'rest', 'buffer'] as const;

export const messageSnapshotSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  authorId: z.string().nullable().default(null),
  authorName: z.string().nullable().default(null),
  authorBot: z.boolean().default(false),
  url: z.string(),
  createdAt: z.number().nullable().default(null),
  editedAt: z.number().nullable().default(null),
  content: z.string().default(''),
  attachments: z.array(attachmentMetaSchema).default([]),
  embeds: z
    .array(
      z.object({
        title: z.string().nullable().default(null),
        description: z.string().nullable().default(null),
        url: z.string().nullable().default(null),
      }),
    )
    .default([]),
  stickers: z.array(z.string()).default([]),
  forwarded: z.boolean().default(false),
  forwardedContent: z.string().nullable().default(null),
  capturedFrom: z.enum(SNAPSHOT_SOURCES).default('interaction'),
});

export type MessageSnapshot = z.infer<typeof messageSnapshotSchema>;

export const MESSAGE_UNAVAILABLE_REASONS = [
  'deleted',
  'no_access',
  'failed',
  'not_captured',
  'purged',
] as const;
export type MessageUnavailableReason = (typeof MESSAGE_UNAVAILABLE_REASONS)[number];

export const messageEvidenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), snapshot: messageSnapshotSchema }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(MESSAGE_UNAVAILABLE_REASONS).catch('failed'),
    ids: z.object({ channelId: z.string(), messageId: z.string() }),
  }),
]);

export type MessageEvidence = z.infer<typeof messageEvidenceSchema>;

export const LINK_STATUSES = [
  'captured',
  'not_found',
  'no_access',
  'other_server',
  'invalid',
  'failed',
] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const linkEvidenceSchema = z.object({
  url: z.string(),
  status: z.enum(LINK_STATUSES).catch('failed'),
  snapshot: messageSnapshotSchema.optional(),
});

export type LinkEvidence = z.infer<typeof linkEvidenceSchema>;

export const evidenceCopySchema = z.union([
  z.object({ channelId: z.string(), messageId: z.string() }),
  z.object({ failed: z.string() }),
]);

export type EvidenceCopy = z.infer<typeof evidenceCopySchema>;

export const reportEvidenceSchema = z.object({
  message: messageEvidenceSchema.optional(),
  links: z.array(linkEvidenceSchema).default([]),
  attachments: z.array(attachmentMetaSchema).default([]),
  copy: evidenceCopySchema.optional(),
  purged: z.boolean().optional(),
});

export type ReportEvidence = z.infer<typeof reportEvidenceSchema>;

export const EMPTY_EVIDENCE: ReportEvidence = { links: [], attachments: [] };

export function readEvidence(raw: unknown): ReportEvidence {
  const parsed = reportEvidenceSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...EMPTY_EVIDENCE };
}

const notificationEntrySchema = z.object({
  outcome: z.enum(NOTIFICATION_OUTCOMES).catch('failed'),
  at: z.number(),
});

export const reportNotificationsSchema = z.object({
  submitted: notificationEntrySchema.optional(),
  accepted: notificationEntrySchema.optional(),
  dismissed: notificationEntrySchema.optional(),
});

export type ReportNotifications = z.infer<typeof reportNotificationsSchema>;

export function readNotifications(raw: unknown): ReportNotifications {
  const parsed = reportNotificationsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const text = z.string().nullable();
const at = z.number().nullable();

export const reportRecordSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  number: z.number().int(),
  reporterId: z.string(),
  targetId: z.string(),
  method: z.enum(REPORT_METHODS),
  status: z.enum(REPORT_STATUSES),

  reasonId: text,
  reason: text,
  customReason: text,
  comment: text,

  sourceChannelId: text,
  sourceMessageId: text,
  sourceAuthorId: text,

  evidence: reportEvidenceSchema,
  evidenceExpiresAt: at,
  evidencePurgedAt: at,

  assigneeId: text,
  assignedAt: at,
  resolvedBy: text,
  resolvedAt: at,
  resolutionNote: text,
  reporterNote: text,
  actionKind: text,
  caseIds: z.array(z.string()),

  card: z.object({
    channelId: text,
    messageId: text,
    evidenceMessageId: text,
    state: z.enum(CARD_STATES),
    error: text,
    attempts: z.number().int(),
    version: z.number().int(),
  }),

  close: z.object({
    action: z.enum(CLOSE_ACTIONS).nullable(),
    dueAt: at,
    closedAt: at,
    attempts: z.number().int(),
    error: text,
  }),

  decision: z.object({ token: text, kind: text, startedAt: at }),
  notifications: reportNotificationsSchema,

  dmChannelId: text,
  dmAttempts: z.number().int(),
  version: z.number().int(),
  idempotencyKey: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ReportRecord = z.infer<typeof reportRecordSchema>;

export const reportEventRecordSchema = z.object({
  id: z.string(),
  reportId: z.string(),
  guildId: z.string(),
  kind: z.string(),
  actorId: z.string().nullable(),
  source: z.enum(REPORT_EVENT_SOURCES).catch('system'),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});

export type ReportEventRecord = z.infer<typeof reportEventRecordSchema>;

export const runOutcomeSchema = z.object({
  index: z.number().int().min(0),
  kind: z.string(),
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
  caseId: z.string().optional(),
  at: z.number(),
});

export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const automationRunSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  targetId: z.string(),
  episodeStart: z.number(),
  coveredUntil: z.number(),
  reportIds: z.array(z.string()),
  status: z.enum(AUTOMATION_RUN_STATUSES).catch('failed'),
  leaseUntil: z.number(),
  outcomes: z.array(runOutcomeSchema),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});

export type AutomationRun = z.infer<typeof automationRunSchema>;

export function readOutcomes(raw: unknown): RunOutcome[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const parsed = runOutcomeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
