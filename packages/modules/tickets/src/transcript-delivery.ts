import type { ActionResult, ModuleContext } from '@proton/core';
import { MODULE_ID, type TicketsConfig, type TicketType, transcriptChannelFor } from './config.ts';
import { namesOf, type TicketsDeps } from './deps.ts';
import { closeCycle, type Ticket, type TicketStore } from './store.ts';
import { renderTranscriptHtml, type TranscriptInput, transcriptFilename } from './transcript.ts';

const EVENT_LIMIT = 500;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function refused(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

function messageUrl(guildId: string, result: ActionResult): string | null {
  const body = record(result.body);
  const messageId = str(body?.id);
  const channelId = str(body?.channel_id);

  return messageId && channelId
    ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
    : null;
}

export interface TranscriptDeliveryInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  deps: TicketsDeps;
  ticket: Ticket;
  type: TicketType | undefined;
  actorId: string;
}

export async function buildTranscript(
  input: TranscriptDeliveryInput,
): Promise<{ html: string; filename: string; view: TranscriptInput }> {
  const { ctx, store, deps, ticket, type } = input;

  const [messages, participants, answers, events, rating] = await Promise.all([
    store.listMessages(ticket.id),
    store.listParticipants(ticket.id),
    store.listAnswers(ticket.id),
    store.listEvents(ticket.id, EVENT_LIMIT),
    store.getRating(ticket.id),
  ]);

  const mentioned = new Set<string>([ticket.openerId, ticket.ownerId, input.actorId]);
  for (const participant of participants) mentioned.add(participant.userId);
  for (const message of messages) mentioned.add(message.authorId);
  for (const event of events) if (event.actorId) mentioned.add(event.actorId);
  if (ticket.claimedById) mentioned.add(ticket.claimedById);
  if (ticket.assignedToId) mentioned.add(ticket.assignedToId);
  if (ticket.closedBy) mentioned.add(ticket.closedBy);

  const view: TranscriptInput = {
    ticket,
    typeName: type?.name ?? ticket.typeId,
    guildName: (await deps.guildName?.(ctx.guildId).catch(() => null)) ?? ctx.guildId,
    messages,
    participants,
    answers,
    events,
    rating,
    displayNames: await namesOf(deps, mentioned),
  };

  return { html: renderTranscriptHtml(view), filename: transcriptFilename(ticket), view };
}

export async function deliverTranscript(input: TranscriptDeliveryInput): Promise<string | null> {
  const { ctx, store, ticket, type } = input;

  const destination = type?.transcript ?? 'channel';
  if (destination === 'off') return null;

  let built: Awaited<ReturnType<typeof buildTranscript>>;
  try {
    built = await buildTranscript(input);
  } catch (error) {
    // A transcript that cannot be rendered must not stop a ticket from closing (§56): the close is
    // the state change, the transcript is a record of it.
    ctx.logger.error(
      `the transcript for ticket #${ticket.number} could not be rendered, so the ticket closed ` +
        `without one: ${error instanceof Error ? error.message : String(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, ticketId: ticket.id },
    );
    return null;
  }

  const file = {
    filename: built.filename,
    contentType: 'text/html',
    data: new TextEncoder().encode(built.html),
    description: `Transcript of ticket #${ticket.number}`,
  };

  const summary =
    `**Ticket #${ticket.number}** · ${built.view.typeName}\n` +
    `Raised by <@${ticket.openerId}>, closed by <@${ticket.closedBy ?? input.actorId}>.\n` +
    `${built.view.messages.length} message(s) recorded.` +
    (ticket.closeReason ? `\n**Reason**\n${ticket.closeReason}` : '');

  let url: string | null = null;

  const channelId = transcriptChannelFor(ctx.config, type);

  if ((destination === 'channel' || destination === 'both') && channelId) {
    const posted = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: input.actorId,
      idempotencyKey: `${MODULE_ID}:transcript:${ticket.id}:${closeCycle(ticket)}`,
      dryRun: false,
      record: false,
      payload: { channelId, content: summary, files: [file], allowedMentions: { parse: [] } },
    });

    if (refused(posted)) {
      ctx.logger.error(
        `the transcript for ticket #${ticket.number} could not be posted to <#${channelId}>, so ` +
          `there is now no copy of it outside the database: ${posted.failure?.humanReason ?? 'unknown reason'}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, code: posted.failure?.code },
      );
    } else {
      url = messageUrl(ctx.guildId, posted);
    }
  }

  if (destination === 'owner' || destination === 'both') {
    await dmTranscript(input, summary, file);
  }

  if (url) await store.setTranscriptUrl(ctx.guildId, ticket.id, url);

  return url;
}

async function dmTranscript(
  input: TranscriptDeliveryInput,
  summary: string,
  file: { filename: string; contentType: string; data: Uint8Array; description: string },
): Promise<void> {
  const { ctx, ticket } = input;

  const dm = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_dm',
    actorId: MODULE_ID,
    idempotencyKey: `${MODULE_ID}:transcript-dm-open:${ticket.id}:${closeCycle(ticket)}`,
    dryRun: false,
    record: false,
    payload: { userId: ticket.ownerId },
  });

  const channelId = str(record(dm.body)?.id);

  // A closed DM is the member's choice, not a failed closure (§33): it is logged and the ticket
  // stays closed.
  if (dm.status !== 'executed' || !channelId) {
    ctx.logger.info(
      `the transcript for ticket #${ticket.number} was not sent to <@${ticket.ownerId}> because ` +
        'Proton could not open a DM with them. The ticket is closed either way.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,
    idempotencyKey: `${MODULE_ID}:transcript-dm:${ticket.id}:${closeCycle(ticket)}`,
    dryRun: false,
    record: false,
    payload: { channelId, content: summary, files: [file], allowedMentions: { parse: [] } },
  });

  if (refused(sent)) {
    ctx.logger.info(
      `the transcript DM for ticket #${ticket.number} was refused: ${sent.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}
