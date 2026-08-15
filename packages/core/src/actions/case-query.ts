import { z } from 'zod';
import { ACTION_KINDS } from './kinds.ts';
import { snowflakeSchema } from './payloads.ts';

/**
 * The ledger's read contract, beside its write contract in `case-recorder.ts`.
 *
 * It lives in core rather than in `apps/api` because two boundaries have to
 * agree on it and neither may drift: the dashboard turns it into router search
 * params, so a filtered case list is a shareable URL (PLAN.md §9), and the API
 * parses the same shape off the wire before touching Postgres. One Zod schema,
 * two boundaries — a second hand-written copy is exactly the drift CLAUDE.md's
 * "schemas are the single source of truth" rule exists to prevent.
 *
 * Executing the query is still domain logic and still lives in `apps/api` (§9).
 */

export const CASE_SORT_FIELDS = ['createdAt', 'caseNumber'] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

export const CASE_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type CaseSortDirection = (typeof CASE_SORT_DIRECTIONS)[number];

export const CASE_PAGE_SIZE_DEFAULT = 50;
/**
 * An upper bound rather than a suggestion: the browser renders this many rows
 * through a virtualiser, but the API materialises all of them, so an unbounded
 * `pageSize` in a hand-edited URL is a trivial way to make one request read a
 * guild's entire moderation history.
 */
export const CASE_PAGE_SIZE_MAX = 200;

export const caseQuerySchema = z
  .object({
    /**
     * `cases.type` is a text column holding an `ActionKind`. The filter is
     * narrowed to the kinds this build knows, so an unknown value is refused
     * at the boundary instead of quietly matching nothing.
     */
    type: z.enum(ACTION_KINDS).optional(),
    /**
     * The moderator who caused the case. Matched against `actor_id` as well as
     * `moderator_id` — see `CaseQueryService`, where the reason lives.
     */
    moderatorId: snowflakeSchema.optional(),
    targetId: snowflakeSchema.optional(),
    /** Inclusive UTC date bounds, `YYYY-MM-DD`, as `<input type="date">` emits. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    sort: z.enum(CASE_SORT_FIELDS).default('createdAt'),
    direction: z.enum(CASE_SORT_DIRECTIONS).default('desc'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(CASE_PAGE_SIZE_MAX).default(CASE_PAGE_SIZE_DEFAULT),
  })
  // A reversed range is a typo that would otherwise return an empty table and
  // look like "this server has no cases", which §1 classes as a bug.
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'the start of the date range must not be after its end',
    path: ['from'],
  });

export type CaseQuery = z.infer<typeof caseQuerySchema>;
/** What a caller may supply — every field with a default is optional here. */
export type CaseQueryInput = z.input<typeof caseQuerySchema>;

/**
 * One row as the dashboard receives it.
 *
 * Timestamps are ISO strings and not `Date`, because this crosses a JSON wire
 * and TanStack Start constrains server-function return types to serializable
 * ones.
 *
 * `payload` is deliberately absent. It holds whatever the action carried —
 * purge payloads can contain message content — and the case list has no use for
 * it, so it never leaves the API.
 */
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
  /** Total matching rows, not rows on this page — the pager needs both. */
  total: number;
  page: number;
  pageSize: number;
}
