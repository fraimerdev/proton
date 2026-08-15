import { z } from 'zod';
import { ACTION_KINDS } from './kinds.ts';
import { snowflakeSchema } from './payloads.ts';

export const CASE_SORT_FIELDS = ['createdAt', 'caseNumber'] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

export const CASE_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type CaseSortDirection = (typeof CASE_SORT_DIRECTIONS)[number];

export const CASE_PAGE_SIZE_DEFAULT = 50;

export const CASE_PAGE_SIZE_MAX = 200;

export const caseQuerySchema = z
  .object({
    type: z.enum(ACTION_KINDS).optional(),

    moderatorId: snowflakeSchema.optional(),
    targetId: snowflakeSchema.optional(),

    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    sort: z.enum(CASE_SORT_FIELDS).default('createdAt'),
    direction: z.enum(CASE_SORT_DIRECTIONS).default('desc'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(CASE_PAGE_SIZE_MAX).default(CASE_PAGE_SIZE_DEFAULT),
  })

  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'the start of the date range must not be after its end',
    path: ['from'],
  });

export type CaseQuery = z.infer<typeof caseQuerySchema>;

export type CaseQueryInput = z.input<typeof caseQuerySchema>;

export interface CaseRecord {
  id: string;
  caseNumber: number;
  type: string;
  actorId: string | null;
  targetId: string | null;
  moderatorId: string | null;
  reason: string | null;
  moduleId: string;
  expiresAt: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  dryRun: boolean;
  createdAt: string;
}

export interface CaseSearchResult {
  cases: CaseRecord[];

  total: number;
  page: number;
  pageSize: number;
}
