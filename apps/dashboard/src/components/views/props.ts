import type {
  BlockedMemberList,
  blockedMemberQuerySchema,
  CaseSearchResult,
  caseQuerySchema,
  LeaderboardResult,
  leaderboardQuerySchema,
} from '@proton/core';
import type { TagSearchResult, tagQuerySchema } from '@proton/module-tags/query';
import type { TicketSearchResult, ticketQuerySchema } from '@proton/module-tickets/query';
import type { ViewProps } from '../module/views.ts';

export type BlockedMembersProps = ViewProps<typeof blockedMemberQuerySchema, BlockedMemberList>;
export type CaseBrowserProps = ViewProps<typeof caseQuerySchema, CaseSearchResult>;
export type LeaderboardProps = ViewProps<typeof leaderboardQuerySchema, LeaderboardResult>;
export type TagBrowserProps = ViewProps<typeof tagQuerySchema, TagSearchResult>;
export type TicketBrowserProps = ViewProps<typeof ticketQuerySchema, TicketSearchResult>;
