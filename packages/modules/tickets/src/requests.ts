import {
  type EventListener,
  type EventType,
  type ModuleContext,
  type TicketOpenRequested,
  ticketOpenAnsweredSchema,
  ticketOpenRequestedSchema,
} from '@proton/core';
import { MODULE_ID, type TicketsConfig, typeFor } from './config.ts';
import { addParticipant } from './controls.ts';
import { bindStore, describeUnbound, nameOf, type TicketsDeps } from './deps.ts';
import { openTicket, reopenTicket } from './lifecycle.ts';
import type { Ticket, TicketFormAnswer, TicketStore } from './store.ts';

export const TICKET_REQUEST_EVENT_TYPES: EventType[] = ['tickets.open_requested'];

export const TICKETS_OFF_REASON = 'Tickets is off in this server.';

export const TICKETS_UNAVAILABLE_REASON =
  'Tickets can’t open tickets for other modules right now because it isn’t fully running.';

const REASON_MAX = 300;

type Ctx = ModuleContext<TicketsConfig>;

type Answer =
  | { status: 'opened' | 'reused' | 'reopened'; ticket: Ticket }
  | { status: 'refused'; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attached(ticket: Ticket): boolean {
  return ticket.channelId !== ticket.id;
}

function contextAnswers(request: TicketOpenRequested): TicketFormAnswer[] {
  return request.context.map((entry, position) => ({
    fieldId: `context_${position + 1}`,
    label: entry.label,
    value: entry.value,
    position,
  }));
}

async function answer(ctx: Ctx, request: TicketOpenRequested, outcome: Answer): Promise<void> {
  const base = {
    guildId: request.guildId,
    requestId: request.requestId,
    sourceModule: request.sourceModule,
    sourceRef: request.sourceRef,
  };

  const payload = ticketOpenAnsweredSchema.parse(
    outcome.status === 'refused'
      ? { ...base, status: 'refused', reason: outcome.reason.slice(0, REASON_MAX) }
      : {
          ...base,
          status: outcome.status,
          ticketId: outcome.ticket.id,
          number: outcome.ticket.number,
          channelId: outcome.ticket.channelId,
        },
  );

  if (!ctx.publish) {
    ctx.logger.warn(
      `tickets ${outcome.status === 'refused' ? 'refused' : 'answered'} ${request.sourceModule}'s ` +
        `request ${request.requestId} but could not say so: this module's context has no publish ` +
        'port. The process running modules must supply ModuleContext.publish.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  try {
    await ctx.publish(
      'tickets.open_answered',
      outcome.status === 'refused' ? `${request.requestId}:refused` : request.requestId,
      payload,
    );
  } catch (error) {
    ctx.logger.error(
      `tickets could not answer ${request.sourceModule}'s request ${request.requestId}, so it ` +
        `will ask again: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

async function include(
  ctx: Ctx,
  store: TicketStore,
  deps: TicketsDeps,
  ticket: Ticket,
  request: TicketOpenRequested,
): Promise<void> {
  const present = new Set((await store.listParticipants(ticket.id)).map((entry) => entry.userId));
  present.add(ticket.ownerId);

  for (const userId of request.participantIds) {
    if (present.has(userId)) continue;

    const added = await addParticipant(
      {
        ctx,
        store,
        deps,
        ticket,
        actorId: request.requestedById,
        idempotencyKey: `${MODULE_ID}:request:${request.requestId}`,
      },
      userId,
    );

    if (!added.ok) {
      ctx.logger.warn(
        `ticket #${ticket.number} was kept for ${request.sourceModule} but ${userId} could not ` +
          `be added to it: ${added.humanReason}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, ticketId: ticket.id },
      );
    }
  }
}

function reopens(ctx: Ctx, ticket: Ticket): boolean {
  return typeFor(ctx.config, ticket.typeId)?.reopenEnabled === true;
}

async function linkedOpen(
  ctx: Ctx,
  store: TicketStore,
  request: TicketOpenRequested,
): Promise<Ticket | null> {
  const linked = await store.bySource(ctx.guildId, request.sourceModule, request.sourceRef);
  return linked?.status === 'open' && attached(linked) ? linked : null;
}

async function handleRequest(
  ctx: Ctx,
  deps: TicketsDeps,
  store: TicketStore,
  request: TicketOpenRequested,
): Promise<void> {
  const type = typeFor(ctx.config, request.typeId);
  if (!type) {
    await answer(ctx, request, {
      status: 'refused',
      reason: `There’s no ticket type with the ID “${request.typeId}” in this server’s Tickets settings.`,
    });
    return;
  }

  const linked = await store.bySource(ctx.guildId, request.sourceModule, request.sourceRef);

  if (linked?.status === 'open' && attached(linked)) {
    await include(ctx, store, deps, linked, request);
    await answer(ctx, request, { status: 'reused', ticket: linked });
    return;
  }

  if (linked && linked.status !== 'open' && attached(linked) && reopens(ctx, linked)) {
    const reopened = await reopenTicket(ctx, store, linked, request.requestedById);

    if (reopened.ok) {
      await include(ctx, store, deps, reopened.ticket, request);
      await answer(ctx, request, { status: 'reopened', ticket: reopened.ticket });
      return;
    }

    const raced = await linkedOpen(ctx, store, request);
    if (raced) {
      await include(ctx, store, deps, raced, request);
      await answer(ctx, request, { status: 'reused', ticket: raced });
      return;
    }
  }

  const opened = await openTicket({
    ctx,
    store,
    deps,
    type,
    panelId: '',
    openerId: request.requestedById,
    openerName: await nameOf(deps, request.requestedById),
    idempotencyKey: `${MODULE_ID}:request:${request.requestId}`,
    answers: contextAnswers(request),
    subject: request.subject ?? null,
    ownerId: request.ownerId,
    source: { module: request.sourceModule, ref: request.sourceRef },
    participantIds: request.participantIds,
    skipMemberLimits: true,
  });

  if (opened.status === 'opened') {
    await answer(ctx, request, { status: 'opened', ticket: opened.ticket });
    return;
  }

  if (opened.status === 'refused') {
    await answer(ctx, request, { status: 'refused', reason: opened.humanReason });
    return;
  }

  const current = await linkedOpen(ctx, store, request);
  if (current) {
    await include(ctx, store, deps, current, request);
    await answer(ctx, request, { status: 'opened', ticket: current });
    return;
  }

  ctx.logger.info(
    `tickets left ${request.sourceModule}'s request ${request.requestId} unanswered: its ticket ` +
      'is still being opened, and the request is asked again if nothing answers it.',
    { guildId: ctx.guildId, moduleId: MODULE_ID },
  );
}

export function createTicketRequestListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_REQUEST_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.guildId === null) return;

      const parsed = ticketOpenRequestedSchema.safeParse(event.payload);
      if (!parsed.success) {
        ctx.logger.error(
          'tickets ignored a request to open a ticket it could not read, so nothing was opened ' +
            `and no answer was sent: ${parsed.error.message}`,
          { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
        );
        return;
      }

      const request = parsed.data;
      if (request.guildId !== ctx.guildId) {
        ctx.logger.error(
          `tickets ignored request ${request.requestId}: it names server ${request.guildId} but ` +
            'arrived for this one.',
          { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
        );
        return;
      }

      if (!ctx.config.enabled) {
        await answer(ctx, request, { status: 'refused', reason: TICKETS_OFF_REASON });
        return;
      }

      const bound = bindStore(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound('opening tickets for other modules', bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        await answer(ctx, request, { status: 'refused', reason: TICKETS_UNAVAILABLE_REASON });
        return;
      }

      await handleRequest(ctx, deps, bound.store, request);
    },
  };
}
