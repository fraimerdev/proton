import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const REPORT_METHODS = ['command', 'user_menu', 'message_menu', 'reaction'] as const;

export type ReportMethod = (typeof REPORT_METHODS)[number];

export const REPORT_STATUSES = ['open', 'in_review', 'accepted', 'dismissed'] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_ACTIONS = [
  'claim',
  'unclaim',
  'assign',
  'accept',
  'dismiss',
  'retry_delivery',
  'repost',
] as const;

export type ReportAction = (typeof REPORT_ACTIONS)[number];

export const moderationReportSubmittedSchema = z.object({
  guildId: snowflakeSchema,
  reportId: z.string(),
  number: z.number().int(),
  reporterId: snowflakeSchema,
  targetId: snowflakeSchema,
  method: z.enum(REPORT_METHODS),
  reason: z.string().nullable(),
  channelId: snowflakeSchema.nullable(),
  messageId: snowflakeSchema.nullable(),
  createdAt: z.number(),
});

export type ModerationReportSubmitted = z.infer<typeof moderationReportSubmittedSchema>;

export const moderationReportResolvedSchema = z.object({
  guildId: snowflakeSchema,
  reportId: z.string(),
  number: z.number().int(),
  targetId: snowflakeSchema,
  reporterId: snowflakeSchema,
  status: z.enum(['accepted', 'dismissed']),
  resolvedBy: z.string(),
  actionKind: z.string().nullable(),
  caseIds: z.array(z.string()),
  resolvedAt: z.number(),
});

export type ModerationReportResolved = z.infer<typeof moderationReportResolvedSchema>;

export const moderationPunishmentExpiredSchema = z.object({
  guildId: snowflakeSchema,
  caseId: z.string(),
  kind: z.literal('timeout'),
  userId: snowflakeSchema,
  endedAt: z.number(),
  memberPresent: z.boolean(),
});

export type ModerationPunishmentExpired = z.infer<typeof moderationPunishmentExpiredSchema>;

export const reportActionParamsSchema = z.object({
  assigneeId: snowflakeSchema.nullable().optional(),
  punishment: z.enum(['none', 'warn', 'timeout', 'kick', 'ban']).optional(),
  reason: z.string().max(512).optional(),
  duration: z.string().max(16).nullable().optional(),
  deleteMessage: z.boolean().optional(),
  note: z.string().max(1000).optional(),
  reporterNote: z.string().max(1000).optional(),
  confirmRecentCase: z.boolean().optional(),
});

export type ReportActionParams = z.infer<typeof reportActionParamsSchema>;

export const moderationReportActionRequestedSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  auditId: z.string(),
  guildId: snowflakeSchema,
  reportId: z.string(),
  action: z.enum(REPORT_ACTIONS),
  params: reportActionParamsSchema,
  actorId: snowflakeSchema,
  actorPermissions: z.string().regex(/^\d+$/),
});

export type ModerationReportActionRequested = z.infer<typeof moderationReportActionRequestedSchema>;

export const reportActionOutcomeSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
  needsConfirmation: z.enum(['recent_case']).optional(),
  caseId: z.string().optional(),
});

export type ReportActionOutcome = z.infer<typeof reportActionOutcomeSchema>;
