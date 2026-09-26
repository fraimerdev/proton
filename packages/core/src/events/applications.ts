import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'in_review',
  'needs_info',
  'waitlisted',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_LIFECYCLE_EVENTS = [
  'applications.submitted',
  'applications.review_started',
  'applications.information_requested',
  'applications.information_provided',
  'applications.waitlisted',
  'applications.accepted',
  'applications.rejected',
  'applications.withdrawn',
  'applications.reopened',
  'applications.expired',
] as const;

export type ApplicationLifecycleEvent = (typeof APPLICATION_LIFECYCLE_EVENTS)[number];

export const applicationLifecycleSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: z.string().min(1).max(64),
  number: z.number().int().min(1),
  formId: z.string().min(1).max(32),
  formName: z.string().min(1).max(100),
  versionId: z.string().min(1).max(64),
  applicantId: snowflakeSchema,
  actorId: z.string().min(1).max(64),
  revision: z.number().int().min(0),
  status: z.enum(APPLICATION_STATUSES),
  occurredAt: z.number().int(),
});

export type ApplicationLifecycle = z.infer<typeof applicationLifecycleSchema>;

export const applicationActionFailedSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: z.string().min(1).max(64),
  number: z.number().int().min(1),
  formId: z.string().min(1).max(32),
  formName: z.string().min(1).max(100),
  effectId: z.string().min(1).max(64),
  kind: z.string().min(1).max(32),
  errorCode: z.string().min(1).max(64),
  revision: z.number().int().min(0),
  occurredAt: z.number().int(),
});

export type ApplicationActionFailed = z.infer<typeof applicationActionFailedSchema>;

export const APPLICATION_WORK_REASONS = [
  'submission',
  'decision',
  'retry',
  'publish',
  'delete',
  'draft',
] as const;

export type ApplicationWorkReason = (typeof APPLICATION_WORK_REASONS)[number];

export const applicationWorkRequestedSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: z.string().min(1).max(64).optional(),
  reason: z.enum(APPLICATION_WORK_REASONS),
});

export type ApplicationWorkRequested = z.infer<typeof applicationWorkRequestedSchema>;
