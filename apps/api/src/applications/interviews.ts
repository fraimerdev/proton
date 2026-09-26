import type { DbHandle } from '@proton/db';
import { tickets } from '@proton/module-tickets/table';
import { and, eq } from 'drizzle-orm';

export type InterviewStatus = 'open' | 'closed' | 'unknown';

export interface InterviewLookup {
  status(guildId: string, ticketId: string): Promise<InterviewStatus>;
}

export function ticketInterviews(handle: DbHandle): InterviewLookup {
  return {
    async status(guildId, ticketId) {
      const [row] = await handle.db
        .select({ status: tickets.status })
        .from(tickets)
        .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId)))
        .limit(1);

      if (!row) return 'unknown';
      return row.status === 'open' ? 'open' : 'closed';
    },
  };
}
