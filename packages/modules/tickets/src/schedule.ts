import { type ModuleContext, parseDuration } from '@proton/core';
import { z } from 'zod';
import { MODULE_ID, type TicketsConfig, type TicketType } from './config.ts';
import type { Ticket } from './store.ts';

export const AUTO_CLOSE_JOB = 'auto-close';
export const AUTO_DELETE_JOB = 'auto-delete';
export const INACTIVITY_WARN_JOB = 'inactivity-warn';
export const CLOSE_REQUEST_JOB = 'close-request';
export const SWEEP_JOB = 'sweep';

export const PER_TICKET_JOBS = [
  AUTO_CLOSE_JOB,
  AUTO_DELETE_JOB,
  INACTIVITY_WARN_JOB,
  CLOSE_REQUEST_JOB,
] as const;

export const TICKET_JOBS = [...PER_TICKET_JOBS, SWEEP_JOB] as const;

export const SWEEP_KEY = 'patrol';

export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export const SWEEP_BATCH = 50;

export const ticketJobDataSchema = z.object({ ticketId: z.string().min(1) });

export type TicketJobData = z.infer<typeof ticketJobDataSchema>;

// parseDuration throws on anything the schema would have rejected, and a stored config that
// predates a tightened schema still reaches here — a throw would take the whole handler down.
function after(from: Date, duration: string | undefined): Date | null {
  if (!duration) return null;

  try {
    return new Date(from.getTime() + parseDuration(duration));
  } catch {
    return null;
  }
}

export function autoCloseAt(type: TicketType | undefined, ticket: Ticket): Date | null {
  return ticket.status === 'open' ? after(ticket.lastActivityAt, type?.autoCloseAfter) : null;
}

export function warnAt(type: TicketType | undefined, ticket: Ticket): Date | null {
  return ticket.status === 'open' ? after(ticket.lastActivityAt, type?.inactivityWarnAfter) : null;
}

export function closeRequestAt(type: TicketType | undefined, ticket: Ticket): Date | null {
  return ticket.status === 'open' && ticket.closeRequestedAt
    ? after(ticket.closeRequestedAt, type?.closeRequestExpiresAfter)
    : null;
}

export function autoDeleteAt(type: TicketType | undefined, ticket: Ticket): Date | null {
  return ticket.status === 'closed' || ticket.status === 'archived'
    ? after(ticket.closedAt ?? ticket.lastActivityAt, type?.autoDeleteAfter)
    : null;
}

async function arm(
  ctx: ModuleContext<TicketsConfig>,
  jobId: string,
  at: Date | null,
  ticketId: string,
): Promise<void> {
  if (at === null) {
    await ctx.cancel?.(jobId, ticketId).catch(() => undefined);
    return;
  }

  // replace: true is the difference between moving a deadline and doing nothing — without it a
  // second schedule under the same key is silently dropped and the ticket keeps the old timer.
  await ctx.schedule?.(jobId, at, ticketId, { ticketId }, { replace: true });
}

export function schedulesTimers(config: TicketsConfig): boolean {
  return config.types.some(
    (type) =>
      type.autoCloseAfter !== undefined ||
      type.inactivityWarnAfter !== undefined ||
      type.autoDeleteAfter !== undefined ||
      type.closeRequestExpiresAfter !== undefined ||
      type.askRating,
  );
}

export async function armTicketTimers(
  ctx: ModuleContext<TicketsConfig>,
  type: TicketType | undefined,
  ticket: Ticket,
): Promise<void> {
  if (!ctx.schedule) {
    if (
      type?.autoCloseAfter ||
      type?.autoDeleteAfter ||
      type?.inactivityWarnAfter ||
      type?.closeRequestExpiresAfter
    ) {
      ctx.logger.warn(
        `ticket #${ticket.number} will not close, warn or tidy itself: this deployment has no ` +
          'durable scheduler wired into the module runtime, so every ticket timer does nothing here.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    }
    return;
  }

  await arm(ctx, AUTO_CLOSE_JOB, autoCloseAt(type, ticket), ticket.id);
  await arm(ctx, INACTIVITY_WARN_JOB, warnAt(type, ticket), ticket.id);
  await arm(ctx, CLOSE_REQUEST_JOB, closeRequestAt(type, ticket), ticket.id);
  await arm(ctx, AUTO_DELETE_JOB, autoDeleteAt(type, ticket), ticket.id);
}

export async function cancelTicketTimers(
  ctx: ModuleContext<TicketsConfig>,
  ticket: Ticket,
): Promise<void> {
  // ctx.cancel takes one key at a time; there is no "cancel everything for this ticket", so a job
  // left out here outlives the ticket and fires against a row that has moved on.
  for (const jobId of PER_TICKET_JOBS) {
    await ctx.cancel?.(jobId, ticket.id).catch((error: unknown) => {
      ctx.logger.warn(
        `ticket #${ticket.number} was finished but its ${jobId} job could not be cancelled: ${
          error instanceof Error ? error.message : String(error)
        }. The job will run, find nothing to do and retire, which is harmless.`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    });
  }
}
