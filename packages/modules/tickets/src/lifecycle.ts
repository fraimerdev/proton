import {
  type ActionResult,
  checkLimit,
  type ModuleContext,
  type PermissionOverwriteSpec,
  parseDuration,
} from '@proton/core';
import {
  MODULE_ID,
  renderChannelName,
  renderOpeningMessage,
  TEXT_CHANNEL_TYPE,
  type TicketPanel,
  type TicketsConfig,
} from './config.ts';
import type { TicketsDeps } from './deps.ts';
import { ticketOverwrites } from './overwrites.ts';
import type { Ticket, TicketStore } from './store.ts';

export const AUTO_CLOSE_JOB = 'auto-close';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export type OpenOutcome =
  | { status: 'opened'; ticket: Ticket }
  | { status: 'duplicate' }
  | { status: 'refused'; humanReason: string };

export interface OpenInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  deps: TicketsDeps;
  panel: TicketPanel;
  openerId: string;
  openerName: string;
  idempotencyKey: string;
}

function failureOf(result: ActionResult, fallback: string): string {
  return result.failure?.humanReason ?? `${fallback} (the action ended as ${result.status})`;
}

export async function openTicket(input: OpenInput): Promise<OpenOutcome> {
  const { ctx, store, panel } = input;

  const limit = checkLimit(
    ctx.tier ?? 'free',
    'openTicketsPerUser',
    await store.countOpenFor(ctx.guildId, input.openerId),
  );

  if (!limit.ok) {
    return {
      status: 'refused',
      humanReason:
        `I did not open another ticket for you: ${limit.humanReason} Close one with ` +
        '`/ticket close` inside it. If one of your ticket channels was deleted without being ' +
        'closed, its slot is still taken — `/ticket list` shows the numbers and ' +
        '`/ticket close number:<number>` clears one from anywhere.',
    };
  }

  const ticket = await store.reserve({
    guildId: ctx.guildId,
    panelId: panel.id,
    openerId: input.openerId,
  });

  const overwrites: PermissionOverwriteSpec[] = ticketOverwrites({
    guildId: ctx.guildId,
    openerId: input.openerId,
    panel,
    botUserId: input.deps.botUserId,
  });

  let created: ActionResult;
  try {
    created = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_channel',
      actorId: input.openerId,
      reason: `ticket #${ticket.number} opened by ${input.openerName}`,
      idempotencyKey: `${input.idempotencyKey}:create`,
      dryRun: false,
      payload: {
        name: renderChannelName(ctx.config.namePattern, ticket.number, input.openerName),
        type: TEXT_CHANNEL_TYPE,
        ...(panel.categoryId ? { parentId: panel.categoryId } : {}),
        permissionOverwrites: overwrites,
      },
    });
  } catch (error) {
    // A throw here — a dead dedupe store, a dead REST proxy — would otherwise leave the reserved
    // row open forever, pointing at no channel and holding one of the member's slots.
    await store.abandon(ctx.guildId, ticket.id);

    ctx.logger.error(
      `ticket #${ticket.number} could not be opened for ${input.openerName}: creating its channel ` +
        `threw ${error instanceof Error ? error.message : String(error)}. The reserved row was ` +
        'removed, so the member can press the button again.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, ticketId: ticket.id },
    );

    return {
      status: 'refused',
      humanReason:
        'Something broke while I was opening your ticket channel, so nothing was recorded. ' +
        'Try again — if a channel did appear, ask a moderator to remove it.',
    };
  }

  // The create key is this press's own event id, so a duplicate claim means the gateway redelivered
  // it: the first delivery opened the channel and owns that ticket. Only the row this delivery
  // reserved goes — the attached one from the first delivery is left exactly as it is.
  if (created.status === 'skipped_duplicate') {
    await store.abandon(ctx.guildId, ticket.id);
    return { status: 'duplicate' };
  }

  if (created.status !== 'executed') {
    await store.abandon(ctx.guildId, ticket.id);

    return {
      status: 'refused',
      humanReason: `I couldn't open a ticket channel: ${failureOf(created, 'Discord refused it')}`,
    };
  }

  const channelId = str(record(created.body)?.id);
  if (!channelId) {
    await store.abandon(ctx.guildId, ticket.id);

    return {
      status: 'refused',
      humanReason:
        'Discord accepted the ticket channel but did not say which channel it made, so the ' +
        'ticket was not recorded. Try again — nothing was left behind.',
    };
  }

  const attached = await store.attach(ctx.guildId, ticket.id, channelId);

  // The channel exists by now, so losing the row is not a reason to pretend nothing happened —
  // it is a reason to say the channel is there and that closing it will need a moderator.
  if (attached === null) {
    ctx.logger.error(
      `ticket #${ticket.number} was opened as <#${channelId}> but its row disappeared before the ` +
        'channel id could be stored, so Proton no longer tracks that channel: /ticket close will ' +
        'not work in it and it has to be removed by hand.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId, ticketId: ticket.id },
    );

    return {
      status: 'refused',
      humanReason:
        `Your channel is open — <#${channelId}> — but Proton lost track of it while opening it, ` +
        'so `/ticket close` will not work there. Ask a moderator to close it for you.',
    };
  }

  await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: input.openerId,
    idempotencyKey: `${input.idempotencyKey}:greeting`,
    dryRun: false,
    record: false,
    payload: {
      channelId,
      content: renderOpeningMessage(panel.openingMessage, input.openerId),
      allowedMentions: { parse: [], users: [input.openerId], roles: panel.supportRoleIds },
    },
  });

  await scheduleAutoClose(ctx, panel, attached);

  return { status: 'opened', ticket: attached };
}

export async function scheduleAutoClose(
  ctx: ModuleContext<TicketsConfig>,
  panel: TicketPanel,
  ticket: Ticket,
  from: Date = new Date(),
): Promise<void> {
  if (!panel.autoCloseAfter) return;

  if (!ctx.schedule) {
    ctx.logger.warn(
      `ticket #${ticket.number} will not close by itself: this deployment has no durable ` +
        'scheduler wired into the module runtime, so autoCloseAfter does nothing here.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const after = parseDuration(panel.autoCloseAfter);

  await ctx.schedule(
    AUTO_CLOSE_JOB,
    new Date(from.getTime() + after),
    ticket.id,
    { ticketId: ticket.id },
    { replace: true },
  );
}

export interface CloseInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  ticket: Ticket;
  closedBy: string;
  reason: string | null;
  idempotencyKey: string;
}

export type CloseOutcome =
  | { ok: true; ticket: Ticket; replayed: boolean }
  | { ok: false; humanReason: string };

export async function closeTicket(input: CloseInput): Promise<CloseOutcome> {
  const { ctx, store, ticket } = input;

  const committed = await store.close({
    guildId: ctx.guildId,
    ticketId: ticket.id,
    closedBy: input.closedBy,
    reason: input.reason,
  });

  // Null means the row was already closed — a redelivered job, a moderator and the auto-close timer
  // landing together, or a close that died after the commit. The effects below run off that row
  // anyway, because nothing else can reach a closed ticket's channel; every one of them is keyed on
  // the ticket, so the executor's dedupe collapses the ones that already happened.
  const closed = committed ?? (await store.get(ctx.guildId, ticket.id));

  if (closed === null || closed.status !== 'closed') {
    return {
      ok: false,
      humanReason:
        `Ticket #${ticket.number} is not in this server's ticket records any more, so there was ` +
        'nothing to close and nothing was changed.',
    };
  }

  await ctx.cancel?.(AUTO_CLOSE_JOB, ticket.id).catch((error: unknown) => {
    ctx.logger.warn(
      `ticket #${ticket.number} was closed but its auto-close job could not be cancelled: ${
        error instanceof Error ? error.message : String(error)
      }. The job will run and find the ticket already closed, which is harmless.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  });

  await postTranscript(ctx, closed);

  await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: input.closedBy,
    idempotencyKey: `${MODULE_ID}:closing:${closed.id}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: closed.channelId,
      content: ctx.config.closeConfirmation,
      allowedMentions: { parse: [] },
    },
  });

  const removed = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_channel',
    actorId: input.closedBy,
    reason: input.reason ?? `ticket #${closed.number} closed`,
    idempotencyKey: `${MODULE_ID}:delete:${closed.id}`,
    dryRun: false,
    payload: { channelId: closed.channelId },
  });

  // A 404 is the wanted end state, not a failure: it is what a channel somebody already deleted by
  // hand answers, and that is exactly the ticket this path exists to clear.
  const gone = removed.failure?.code === 'discord_404';

  if (!gone && (removed.status === 'failed_precheck' || removed.status === 'failed_api')) {
    ctx.logger.error(
      `ticket #${closed.number} is closed but its channel could not be removed, so it is still ` +
        `in the channel list: ${failureOf(removed, 'Discord refused it')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: removed.failure?.code },
    );
  }

  return { ok: true, ticket: closed, replayed: committed === null };
}

export function transcriptLine(ticket: Ticket, panelName: string): string {
  const opened = Math.floor(ticket.openedAt.getTime() / 1000);
  const closed = Math.floor((ticket.closedAt ?? new Date()).getTime() / 1000);

  return (
    `**Ticket #${ticket.number}** · ${panelName}\n` +
    `Opened by <@${ticket.openerId}> <t:${opened}:f>, closed by <@${ticket.closedBy ?? 'unknown'}> ` +
    `<t:${closed}:f>.` +
    (ticket.closeReason ? `\nReason: ${ticket.closeReason}` : '')
  );
}

async function postTranscript(ctx: ModuleContext<TicketsConfig>, ticket: Ticket): Promise<void> {
  const panel = ctx.config.panels.find((entry) => entry.id === ticket.panelId);
  const channelId = panel?.transcriptChannelId;
  if (!panel || !channelId) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ticket.closedBy ?? MODULE_ID,
    idempotencyKey: `${MODULE_ID}:transcript:${ticket.id}`,
    dryRun: false,
    record: false,
    payload: {
      channelId,
      content: transcriptLine(ticket, panel.name),
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `the record for ticket #${ticket.number} could not be posted to the transcript channel, so ` +
        `there is now no trace of it outside the database: ${failureOf(result, 'Discord refused it')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
