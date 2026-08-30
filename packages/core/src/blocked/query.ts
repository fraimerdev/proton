import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const BLOCK_REASON_MAX = 512;

export const BLOCKED_STATES = ['live', 'lifted', 'all'] as const;
export type BlockedState = (typeof BLOCKED_STATES)[number];

export const BLOCKED_PAGE_SIZE_DEFAULT = 50;
export const BLOCKED_PAGE_SIZE_MAX = 200;

export const blockedEvidenceSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
});

export type BlockedEvidence = z.infer<typeof blockedEvidenceSchema>;

export const blockMemberInputSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  moduleId: z.string().min(1).max(64),
  blockedBy: z.string().min(1).max(64),

  reason: z.string().trim().min(1).max(BLOCK_REASON_MAX),

  caseId: z.string().min(1).max(64).optional(),
  evidence: blockedEvidenceSchema.optional(),

  idempotencyKey: z.string().min(1).max(256),
});

export type BlockMemberInput = z.infer<typeof blockMemberInputSchema>;

export const liftBlockInputSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  liftedBy: z.string().min(1).max(64),
  liftReason: z.string().trim().min(1).max(BLOCK_REASON_MAX),
});

export type LiftBlockInput = z.infer<typeof liftBlockInputSchema>;

export const blockedMemberSchema = z.object({
  id: z.string(),
  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  moduleId: z.string(),
  blockedBy: z.string(),
  reason: z.string(),

  caseId: z.string().nullable(),
  evidence: blockedEvidenceSchema.nullable(),

  // ISO strings, not Dates: this shape crosses the wire to the dashboard, the same way
  // CaseRecord.createdAt does.
  createdAt: z.iso.datetime(),

  liftedAt: z.iso.datetime().nullable(),
  liftedBy: z.string().nullable(),
  liftReason: z.string().nullable(),
});

export type BlockedMember = z.infer<typeof blockedMemberSchema>;

export const blockedMemberQuerySchema = z.object({
  state: z.enum(BLOCKED_STATES).default('live'),

  userId: snowflakeSchema.optional(),
  moduleId: z.string().min(1).max(64).optional(),

  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(BLOCKED_PAGE_SIZE_MAX)
    .default(BLOCKED_PAGE_SIZE_DEFAULT),

  order: z.enum(['asc', 'desc']).default('desc'),
});

export type BlockedMemberQuery = z.infer<typeof blockedMemberQuerySchema>;

export const blockedMemberListSchema = z.object({
  rows: z.array(blockedMemberSchema),
  total: z.number().int().nonnegative(),
});

export type BlockedMemberList = z.infer<typeof blockedMemberListSchema>;

export const liftBlockResultSchema = z.object({
  lifted: z.boolean(),
  userId: snowflakeSchema,
});

export type LiftBlockResult = z.infer<typeof liftBlockResultSchema>;

export interface BlockedMemberStore {
  block(input: BlockMemberInput): Promise<{ blocked: boolean }>;

  find(guildId: string, userId: string): Promise<BlockedMember | null>;

  list(guildId: string, query: BlockedMemberQuery): Promise<BlockedMemberList>;

  lift(input: LiftBlockInput): Promise<LiftBlockResult>;
}
