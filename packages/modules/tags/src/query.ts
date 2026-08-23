import { z } from 'zod';
import type { Tag } from './store.ts';

export const TAG_PAGE_SIZE_DEFAULT = 25;
export const TAG_PAGE_SIZE_MAX = 100;

export const TAG_SORT_FIELDS = ['name', 'uses', 'createdAt'] as const;
export type TagSortField = (typeof TAG_SORT_FIELDS)[number];

export const TAG_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type TagSortDirection = (typeof TAG_SORT_DIRECTIONS)[number];

export const tagQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(TAG_PAGE_SIZE_MAX).default(TAG_PAGE_SIZE_DEFAULT),

  search: z.string().max(64).optional(),

  sort: z.enum(TAG_SORT_FIELDS).default('name'),
  direction: z.enum(TAG_SORT_DIRECTIONS).default('asc'),
});

export type TagQueryInput = z.input<typeof tagQuerySchema>;
export type TagQuery = z.output<typeof tagQuerySchema>;

export interface TagSummary {
  name: string;
  content: string;
  createdBy: string;
  updatedBy: string | null;
  uses: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagSearchResult {
  tags: TagSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export function toSummary(tag: Tag): TagSummary {
  return {
    name: tag.name,
    content: tag.content,
    createdBy: tag.createdBy,
    updatedBy: tag.updatedBy,
    uses: tag.uses,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}
