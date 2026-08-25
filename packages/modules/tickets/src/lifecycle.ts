import {
  type ActionResult,
  checkLimit,
  limitFor,
  type ModuleContext,
  type PermissionOverwriteSpec,
  parseDuration,
  type TicketPriority,
} from '@proton/core';
import {
  MODULE_ID,
  renderChannelName,
  staffRolesFor,
  TEXT_CHANNEL_TYPE,
  type TicketsConfig,
  type TicketType,
  typeFor,
} from './config.ts';
import { clockOf, type TicketsDeps } from './deps.ts';
import { buildRatingComponents, buildWelcomeComponents, type TicketView } from './interface.ts';
import {
  OVERWRITE_MEMBER,
  TICKET_LOCKED_ALLOW,
  TICKET_LOCKED_DENY,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
} from './overwrites.ts';
import { armTicketTimers, cancelTicketTimers } from './schedule.ts';
import {
  closeCycle,
  openCycle,
  type Ticket,
  type TicketFormAnswer,
  type TicketStatus,
  type TicketStore,
} from './store.ts';
import { deliverTranscript } from './transcript-delivery.ts';

export {
  AUTO_CLOSE_JOB,
  AUTO_DELETE_JOB,
  CLOSE_REQUEST_JOB,
  INACTIVITY_WARN_JOB,
  SWEEP_JOB,
} from './schedule.ts';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function failureOf(result: ActionResult, fallback: string): string {
  return result.failure?.humanReason ?? `${fallback} (the action ended as ${result.status})`;
}

export function refused(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

export type OpenOutcome =
  | { status: 'opened'; ticket: Ticket }
  | { status: 'duplicate' }
  | { status: 'refused'; humanReason: string };

export interface OpenInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  deps: TicketsDeps;
  type: TicketType;
  panelId: string;
  openerId: string;
  openerName: string;
  idempotencyKey: string;

  answers?: readonly TicketFormAnswer[];
  priority?: TicketPriority | undefined;
  subject?: string | null | undefined;
}

export interface GateInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  type: TicketType;
  openerId: string;
  now: Date;
}

export type GateOutcome = { ok: true } | { ok: false; humanReason: string };

export async function mayOpen(input: GateInput): Promise<GateOutcome> {
  const { ctx, store, type, openerId } = input;

  const entry = await store.blacklistEntry(ctx.guildId, openerId, input.now);
  if (entry) {
    return {
      ok: false,
      humanReason:
        `${ctx.config.blacklistMessage}` +
        (entry.reason ? `\n\n**Reason**\n${entry.reason}` : '') +
        (entry.expiresAt
          ? `\n\nThis lifts <t:${Math.floor(entry.expiresAt.getTime() / 1000)}:R>.`
          : ''),
    };
  }

  const tier = checkLimit(
    ctx.tier ?? 'free',
    'openTicketsPerUser',
    await store.countOpenFor(ctx.guildId, openerId),
  );

  if (!tier.ok) {
    return {
      ok: false,
      humanReason:
        `I did not open another ticket for you: ${tier.humanReason} Close one with ` +
        '`/ticket close` inside it. If one of your ticket channels was deleted without being ' +
        'closed, its slot is still taken — `/ticket list` shows the numbers and ' +
        '`/ticket close number:<number>` clears one from anywhere.',
    };
  }

  const inGuild = await store.countOpen(ctx.guildId);
  if (inGuild >= ctx.config.maxOpenPerGuild) {
    return {
      ok: false,
      humanReason:
        `This server already has ${inGuild} open tickets, which is the most it allows at once. ` +
        'The support team needs to close some before new ones can be opened.',
    };
  }

  const open = await store.countOpenFor(ctx.guildId, openerId);
  if (open >= ctx.config.maxOpenPerUser) {
    return {
      ok: false,
      humanReason:
        `You already have ${open} open ticket(s) and this server allows ` +
        `${ctx.config.maxOpenPerUser}. Close one before opening another.`,
    };
  }

  if (type.maxOpenPerUser !== undefined) {
    const forType = await store.countOpenForType(ctx.guildId, openerId, type.id);

    if (forType >= type.maxOpenPerUser) {
      return {
        ok: false,
        humanReason:
          `You already have ${forType} open **${type.name}** ticket(s), which is the most this ` +
          'server allows for that kind. Close one before opening another.',
      };
    }
  }

  const cooldown = type.cooldown ?? ctx.config.creationCooldown;
  const last = await store.lastOpenedAt(ctx.guildId, openerId);

  if (last) {
    let waitMs = 0;
    try {
      waitMs = parseDuration(cooldown) - (input.now.getTime() - last.getTime());
    } catch {
      waitMs = 0;
    }

    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);

      return {
        ok: false,
        humanReason: `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before opening another ticket.`,
      };
    }
  }

  return { ok: true };
}

async function overCap(input: OpenInput, ticket: Ticket): Promise<string | null> {
  const { ctx, store, type } = input;

  const rank = await store.openRankAt(ctx.guildId, ticket.ownerId, ticket.number);

  const ceiling = Math.min(
    ctx.config.maxOpenPerUser,
    limitFor(ctx.tier ?? 'free', 'openTicketsPerUser'),
  );

  if (rank > ceiling) {
    return (
      `You already have ${ceiling} open ticket(s), which is the most this server allows. Close ` +
      'one before opening another.'
    );
  }

  if (type.maxOpenPerUser === undefined) return null;

  const forType = await store.openRankAt(ctx.guildId, ticket.ownerId, ticket.number, type.id);

  return forType > type.maxOpenPerUser
    ? `You already have ${type.maxOpenPerUser} open **${type.name}** ticket(s), which is the most ` +
        'this server allows for that kind. Close one before opening another.'
    : null;
}

export async function openTicket(input: OpenInput): Promise<OpenOutcome> {
  const { ctx, store, type, deps } = input;

  const gate = await mayOpen({
    ctx,
    store,
    type,
    openerId: input.openerId,
    now: clockOf(deps),
  });

  if (!gate.ok) return { status: 'refused', humanReason: gate.humanReason };

  const ticket = await store.reserve({
    guildId: ctx.guildId,
    typeId: type.id,
    panelId: input.panelId,
    openerId: input.openerId,
    priority: input.priority ?? type.defaultPriority,
    subject: input.subject ?? undefined,
  });

  // Re-checked now that the row exists. mayOpen ran before the insert, so two presses a moment
  // apart both saw room; whichever landed second is the one that stands down.
  const crowded = await overCap(input, ticket);

  if (crowded !== null) {
    await store.abandon(ctx.guildId, ticket.id);
    return { status: 'refused', humanReason: crowded };
  }

  const staffRoleIds = staffRolesFor(ctx.config, type);

  const overwrites: PermissionOverwriteSpec[] = ticketOverwrites({
    guildId: ctx.guildId,
    ownerId: input.openerId,
    staffRoleIds,
    botUserId: deps.botUserId,
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
      record: false,
      payload: {
        name: renderChannelName(
          type.namePattern ?? ctx.config.namePattern,
          ticket.number,
          input.openerName,
          type.name,
        ),
        type: TEXT_CHANNEL_TYPE,
        ...(type.categoryId ? { parentId: type.categoryId } : {}),
        ...(input.subject ? { topic: input.subject.slice(0, 1024) } : {}),
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

  await store.addParticipant(attached.id, input.openerId, 'opener', null);

  if (input.answers?.length) await store.saveAnswers(attached.id, input.answers);

  await store.recordEvent({
    ticketId: attached.id,
    guildId: ctx.guildId,
    type: 'created',
    actorId: input.openerId,
    data: { typeId: type.id, panelId: input.panelId, priority: attached.priority },
  });

  const view: TicketView = {
    ticket: attached,
    type,
    typeName: type.name,
    staffRoleIds,
    answers: input.answers ?? [],
    participants: [],
  };

  const welcome = buildWelcomeComponents(view, type.welcomeMessage);

  if (welcome.ok) {
    const mention = type.mentionStaffOnOpen
      ? staffRoleIds.map((roleId) => `<@&${roleId}>`).join(' ')
      : '';

    const posted = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: input.openerId,
      idempotencyKey: `${MODULE_ID}:welcome:${attached.id}`,
      dryRun: false,
      record: false,
      payload: {
        channelId,
        components: welcome.value,
        flags: 32768,
        allowedMentions: { parse: [], users: [attached.ownerId], roles: staffRoleIds },
      },
    });

    if (refused(posted)) {
      ctx.logger.error(
        `ticket #${attached.number} was opened but its welcome message and controls could not be ` +
          `posted, so the member sees an empty channel: ${failureOf(posted, 'Discord refused it')}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, code: posted.failure?.code },
      );
    } else if (mention) {
      // A separate message, because a Components V2 payload may not carry content and a role
      // mention inside a container does not notify anybody.
      await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'send',
        actorId: input.openerId,
        idempotencyKey: `${MODULE_ID}:notify:${attached.id}`,
        dryRun: false,
        record: false,
        payload: {
          channelId,
          content: mention,
          allowedMentions: { parse: [], roles: staffRoleIds },
        },
      });
    }
  } else {
    ctx.logger.error(
      `ticket #${attached.number} opened without its control panel: ${welcome.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }

  await armTicketTimers(ctx, type, attached);

  await ctx.publish?.('tickets.opened', attached.id, {
    guildId: ctx.guildId,
    ticketId: attached.id,
    number: attached.number,
    channelId,
    typeId: type.id,
    typeName: type.name,
    openerId: attached.openerId,
    priority: attached.priority,
    ...(attached.subject ? { subject: attached.subject } : {}),
  });

  return { status: 'opened', ticket: attached };
}

export interface CloseInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  deps: TicketsDeps;
  ticket: Ticket;
  closedBy: string;
  reason: string | null;
  idempotencyKey: string;
}

export type CloseOutcome =
  | { ok: true; ticket: Ticket; replayed: boolean }
  | { ok: false; humanReason: string };

export async function closeTicket(input: CloseInput): Promise<CloseOutcome> {
  const { ctx, store, ticket, deps } = input;

  const committed = await store.close({
    guildId: ctx.guildId,
    ticketId: ticket.id,
    closedBy: input.closedBy,
    reason: input.reason,
  });

  // Null means the row was already closed — a redelivered job, a moderator and the auto-close timer
  // landing together, or a close that died after the commit. The effects below run off that row
  // anyway; every one of them is keyed on the ticket, so the executor's dedupe collapses the ones
  // that already happened.
  const closed = committed ?? (await store.get(ctx.guildId, ticket.id));

  if (closed === null || closed.status === 'open' || closed.status === 'deleted') {
    return {
      ok: false,
      humanReason:
        `Ticket #${ticket.number} is not in a state I can close, so nothing was changed. It may ` +
        'have been deleted while you were looking at it.',
    };
  }

  const type = typeFor(ctx.config, closed.typeId);

  if (committed) {
    await store.recordEvent({
      ticketId: closed.id,
      guildId: ctx.guildId,
      type: 'closed',
      actorId: input.closedBy,
      data: input.reason === null ? undefined : { reason: input.reason },
    });
  }

  await cancelTicketTimers(ctx, closed);

  const transcript = await deliverTranscript({
    ctx,
    store,
    deps,
    ticket: closed,
    type,
    actorId: input.closedBy,
  });

  await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: input.closedBy,
    idempotencyKey: `${MODULE_ID}:closing:${closed.id}:${closeCycle(closed)}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: closed.channelId,
      content: ctx.config.closeConfirmation,
      allowedMentions: { parse: [] },
    },
  });

  await lockForClose(ctx, closed);

  if (type?.archiveOnClose) await archiveTicket(ctx, store, closed);

  if (type?.askRating) await askForRating(ctx, closed);

  await armTicketTimers(ctx, type, { ...closed, status: 'closed' });

  await ctx.publish?.('tickets.closed', closed.id, {
    guildId: ctx.guildId,
    ticketId: closed.id,
    number: closed.number,
    channelId: closed.channelId,
    typeId: closed.typeId,
    typeName: type?.name ?? closed.typeId,
    openerId: closed.openerId,
    closedById: input.closedBy,
    reason: input.reason,
    openedAt: closed.openedAt.getTime(),
    closedAt: (closed.closedAt ?? new Date()).getTime(),
    messageCount: closed.messageCount,
    ...(transcript ? { transcriptUrl: transcript } : {}),
  });

  return { ok: true, ticket: closed, replayed: committed === null };
}

// The member keeps reading it and loses the ability to add to it: a closed ticket that can still be
// typed in collects the replies staff will never see, because nothing watches a closed channel.
async function lockForClose(ctx: ModuleContext<TicketsConfig>, ticket: Ticket): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_channel_overwrite',
    actorId: ticket.closedBy ?? MODULE_ID,
    reason: `ticket #${ticket.number} closed`,
    idempotencyKey: `${MODULE_ID}:close-lock:${ticket.id}:${closeCycle(ticket)}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: ticket.channelId,
      overwriteId: ticket.ownerId,
      type: OVERWRITE_MEMBER,
      allow: TICKET_LOCKED_ALLOW.toString(),
      deny: TICKET_LOCKED_DENY.toString(),
    },
  });

  if (refused(result)) {
    ctx.logger.warn(
      `ticket #${ticket.number} is closed but the member can still post in its channel: ` +
        failureOf(result, 'Discord refused the permission change'),
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

export async function archiveTicket(
  ctx: ModuleContext<TicketsConfig>,
  store: TicketStore,
  ticket: Ticket,
): Promise<boolean> {
  const type = typeFor(ctx.config, ticket.typeId);
  const category = type?.archiveCategoryId;

  const archived = await store.archive(ctx.guildId, ticket.id);
  if (!archived) return false;

  await store.recordEvent({
    ticketId: ticket.id,
    guildId: ctx.guildId,
    type: 'archived',
    actorId: null,
  });

  if (!category) return true;

  const moved = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: MODULE_ID,
    reason: `ticket #${ticket.number} archived`,
    idempotencyKey: `${MODULE_ID}:archive:${ticket.id}:${closeCycle(ticket)}`,
    dryRun: false,
    record: false,
    payload: { channelId: ticket.channelId, parentId: category },
  });

  if (refused(moved)) {
    ctx.logger.warn(
      `ticket #${ticket.number} is archived but its channel could not be moved into the archive ` +
        `category: ${failureOf(moved, 'Discord refused it')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: moved.failure?.code },
    );
  }

  return true;
}

export type ReopenOutcome = { ok: true; ticket: Ticket } | { ok: false; humanReason: string };

export async function reopenTicket(
  ctx: ModuleContext<TicketsConfig>,
  store: TicketStore,
  ticket: Ticket,
  byId: string,
): Promise<ReopenOutcome> {
  const reopened = await store.reopen(ctx.guildId, ticket.id, byId);

  if (!reopened) {
    return {
      ok: false,
      humanReason: `Ticket #${ticket.number} is not closed, so there was nothing to reopen.`,
    };
  }

  const type = typeFor(ctx.config, reopened.typeId);

  const restored = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_channel_overwrite',
    actorId: byId,
    reason: `ticket #${reopened.number} reopened`,
    idempotencyKey: `${MODULE_ID}:reopen-unlock:${reopened.id}:${openCycle(reopened)}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: reopened.channelId,
      overwriteId: reopened.ownerId,
      type: OVERWRITE_MEMBER,
      allow: TICKET_MEMBER_ALLOW.toString(),
      deny: '0',
    },
  });

  if (refused(restored)) {
    ctx.logger.warn(
      `ticket #${reopened.number} was reopened but the member cannot post in it again: ` +
        failureOf(restored, 'Discord refused the permission change'),
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: restored.failure?.code },
    );
  }

  if (type?.categoryId) {
    await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'edit_channel',
      actorId: byId,
      reason: `ticket #${reopened.number} reopened`,
      idempotencyKey: `${MODULE_ID}:reopen-move:${reopened.id}:${openCycle(reopened)}`,
      dryRun: false,
      record: false,
      payload: { channelId: reopened.channelId, parentId: type.categoryId },
    });
  }

  await armTicketTimers(ctx, type, reopened);

  await ctx.publish?.('tickets.reopened', reopened.id, {
    guildId: ctx.guildId,
    ticketId: reopened.id,
    number: reopened.number,
    channelId: reopened.channelId,
    typeId: reopened.typeId,
    typeName: type?.name ?? reopened.typeId,
    reopenedById: byId,
  });

  return { ok: true, ticket: reopened };
}

export type DeleteOutcome = { ok: true; ticket: Ticket } | { ok: false; humanReason: string };

export async function deleteTicket(
  ctx: ModuleContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
  ticket: Ticket,
  byId: string,
  reason: string | null,
  expected?: readonly TicketStatus[],
): Promise<DeleteOutcome> {
  const type = typeFor(ctx.config, ticket.typeId);

  // Before the row flips, because a transcript of a deleted ticket is the only thing left of it and
  // markDeleted is what makes the row unreadable to everything downstream.
  if (ticket.status === 'open') {
    await deliverTranscript({ ctx, store, deps, ticket, type, actorId: byId });
  }

  const removed = await store.markDeleted(ctx.guildId, ticket.id, byId, reason, expected);

  if (!removed) {
    return {
      ok: false,
      humanReason:
        expected === undefined
          ? `Ticket #${ticket.number} was already deleted, so nothing was changed.`
          : `Ticket #${ticket.number} changed while it was being tidied up, so it was left alone.`,
    };
  }

  await cancelTicketTimers(ctx, removed);

  const gone = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_channel',
    actorId: byId,
    reason: reason ?? `ticket #${removed.number} deleted`,
    idempotencyKey: `${MODULE_ID}:delete:${removed.id}`,
    dryRun: false,
    record: false,
    payload: { channelId: removed.channelId },
  });

  // A 404 is the wanted end state, not a failure: it is what a channel somebody already deleted by
  // hand answers, and that is exactly the ticket this path exists to clear.
  if (refused(gone) && gone.failure?.code !== 'discord_404') {
    ctx.logger.error(
      `ticket #${removed.number} is marked deleted but its channel is still in the channel list: ` +
        failureOf(gone, 'Discord refused it'),
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: gone.failure?.code },
    );
  }

  await ctx.publish?.('tickets.deleted', removed.id, {
    guildId: ctx.guildId,
    ticketId: removed.id,
    number: removed.number,
    channelId: removed.channelId,
    typeId: removed.typeId,
    typeName: type?.name ?? removed.typeId,
    deletedById: byId,
    reason,
  });

  return { ok: true, ticket: removed };
}

async function askForRating(ctx: ModuleContext<TicketsConfig>, ticket: Ticket): Promise<void> {
  const components = buildRatingComponents(ticket);
  if (!components.ok) return;

  const dm = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_dm',
    actorId: MODULE_ID,
    idempotencyKey: `${MODULE_ID}:rating-dm:${ticket.id}:${closeCycle(ticket)}`,
    dryRun: false,
    record: false,
    payload: { userId: ticket.ownerId },
  });

  const channelId = str(record(dm.body)?.id);

  // Falls back into the ticket channel rather than giving up: a member with DMs closed is the
  // common case, not an error, and the prompt is useless if it never reaches anybody.
  const target = dm.status === 'executed' && channelId ? channelId : ticket.channelId;

  const asked = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,
    idempotencyKey: `${MODULE_ID}:rating:${ticket.id}:${closeCycle(ticket)}`,
    dryRun: false,
    record: false,
    payload: {
      channelId: target,
      components: components.value,
      flags: 32768,
      allowedMentions: { parse: [] },
    },
  });

  if (refused(asked)) {
    ctx.logger.info(
      `ticket #${ticket.number} closed without asking for a rating: ${failureOf(asked, 'Discord refused it')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}
