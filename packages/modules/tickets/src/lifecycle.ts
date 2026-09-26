import {
  type ActionResult,
  checkLimit,
  errorStatus,
  type GuildState,
  labelOf,
  limitFor,
  type ModuleContext,
  newId,
  type PermissionOverwriteSpec,
  parseDuration,
  type StatusBody,
  type TicketPriority,
} from '@proton/core';
import { clipGraphemes } from '@proton/core/placeholders';
import { ComponentType } from 'discord-api-types/v10';
import {
  MODULE_ID,
  staffRolesFor,
  TEXT_CHANNEL_TYPE,
  type TicketsConfig,
  type TicketType,
  typeFor,
} from './config.ts';
import {
  clockOf,
  isProtonActor,
  nameOf,
  placeholderReads,
  readBot,
  readProfile,
  readServer,
  type TicketsDeps,
  ticketFacts,
} from './deps.ts';
import { buildRatingComponents, buildWelcomeComponents, type TicketView } from './interface.ts';
import {
  OVERWRITE_MEMBER,
  TICKET_LOCKED_ALLOW,
  TICKET_LOCKED_DENY,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
} from './overwrites.ts';
import {
  renderTicketChannelName,
  renderTicketText,
  TICKET_BLACKLIST_SURFACE,
  TICKET_CLOSE_SURFACE,
  TICKET_NAME_SURFACE,
  TICKET_TEXT_MAX,
  TICKET_WELCOME_SURFACE,
  ticketSourcesFor,
} from './placeholders.ts';
import { armTicketTimers, cancelTicketTimers } from './schedule.ts';
import {
  type BlacklistEntry,
  closeCycle,
  openCycle,
  type Ticket,
  type TicketFormAnswer,
  type TicketSource,
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

function tickets(count: number, kind = ''): string {
  return `${count} open ${kind}${count === 1 ? 'ticket' : 'tickets'}`;
}

function typeCap(count: number, type: TicketType): string {
  return (
    `You already have ${tickets(count, `**${type.name}** `)}, the most this server allows. ` +
    'Close one before opening another.'
  );
}

export type OpenOutcome =
  | { status: 'opened'; ticket: Ticket }
  | { status: 'duplicate' }
  | { status: 'pending'; ticket: Ticket }
  | { status: 'refused'; humanReason: string; authored?: boolean };

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

  ownerId?: string | undefined;
  source?: TicketSource | undefined;
  participantIds?: readonly string[] | undefined;
  skipMemberLimits?: boolean | undefined;
}

export interface GateInput {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  type: TicketType;
  openerId: string;
  now: Date;
  deps?: TicketsDeps | undefined;
  priority?: TicketPriority | undefined;
  skipMemberLimits?: boolean | undefined;
}

// `authored` marks a refusal whose words are the admin's own blacklist template, not Proton's.
// Wrapping that in a status embed would print Proton's cross against somebody else's sentence.
export type GateOutcome = { ok: true } | { ok: false; humanReason: string; authored?: boolean };

async function blacklistRefusal(input: GateInput, entry: BlacklistEntry): Promise<string> {
  const { ctx, type, openerId } = input;
  const template = ctx.config.blacklistMessage;
  const reads = placeholderReads(
    ctx,
    input.deps ?? {},
    ticketSourcesFor(TICKET_BLACKLIST_SURFACE, [template]),
  );

  const message = renderTicketText(
    TICKET_BLACKLIST_SURFACE,
    template,
    {
      ticket: null,
      typeName: type.name,
      priority: input.priority ?? type.defaultPriority,
      ownerId: openerId,
      owner: await readProfile(reads, openerId, reads.sources.owner),
      blacklist: { reason: entry.reason, expiresAt: entry.expiresAt },
      server: await readServer(reads),
      bot: await readBot(reads),
    },
    input.now.getTime(),
  );

  const suffix =
    (entry.reason ? `\n\n**Reason**\n${entry.reason}` : '') +
    (entry.expiresAt
      ? `\n\nYou can open tickets again <t:${Math.floor(entry.expiresAt.getTime() / 1000)}:R>.`
      : '');

  return clipGraphemes(message, Math.max(0, TICKET_TEXT_MAX - suffix.length)) + suffix;
}

async function serverCap(input: GateInput): Promise<GateOutcome> {
  const inGuild = await input.store.countOpen(input.ctx.guildId);
  if (inGuild < input.ctx.config.maxOpenPerGuild) return { ok: true };

  return {
    ok: false,
    humanReason:
      `This server already has ${inGuild} open tickets, the most it allows at once. Try ` +
      'again once staff have closed some.',
  };
}

export async function mayOpen(input: GateInput): Promise<GateOutcome> {
  const { ctx, store, type, openerId } = input;

  if (input.skipMemberLimits) return serverCap(input);

  const entry = await store.blacklistEntry(ctx.guildId, openerId, input.now);
  if (entry) {
    return { ok: false, humanReason: await blacklistRefusal(input, entry), authored: true };
  }

  const tier = checkLimit(
    ctx.tier ?? 'free',
    'openTicketsPerUser',
    await store.countOpenFor(ctx.guildId, openerId),
  );

  if (!tier.ok) {
    const close = labelOf(ctx, 'ticket', 'close');

    return {
      ok: false,
      humanReason:
        `I couldn’t open another ticket: ${tier.humanReason} Close one with \`${close}\` ` +
        'inside it. A ticket channel deleted without being closed may still count. Find its ' +
        `number with \`${labelOf(ctx, 'ticket', 'list')}\` and close it from anywhere with ` +
        `\`${close} number:<number>\`.`,
    };
  }

  const full = await serverCap(input);
  if (!full.ok) return full;

  const open = await store.countOpenFor(ctx.guildId, openerId);
  if (open >= ctx.config.maxOpenPerUser) {
    return {
      ok: false,
      humanReason:
        `You already have ${tickets(open)}, and this server allows ` +
        `${ctx.config.maxOpenPerUser}. Close one before opening another.`,
    };
  }

  if (type.maxOpenPerUser !== undefined) {
    const forType = await store.countOpenForType(ctx.guildId, openerId, type.id);

    if (forType >= type.maxOpenPerUser) {
      return { ok: false, humanReason: typeCap(forType, type) };
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
        humanReason: `You can open another ticket in ${seconds} second${seconds === 1 ? '' : 's'}.`,
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
      `You already have ${tickets(ceiling)}, the most this server allows. Close one before ` +
      'opening another.'
    );
  }

  if (type.maxOpenPerUser === undefined) return null;

  const forType = await store.openRankAt(ctx.guildId, ticket.ownerId, ticket.number, type.id);

  return forType > type.maxOpenPerUser ? typeCap(type.maxOpenPerUser, type) : null;
}

export function refusalBody(outcome: {
  humanReason: string;
  authored?: boolean;
}): string | StatusBody {
  return outcome.authored ? outcome.humanReason : errorStatus(outcome.humanReason);
}

export async function openTicket(input: OpenInput): Promise<OpenOutcome> {
  const { ctx, store, type, deps } = input;
  const ownerId = input.ownerId ?? input.openerId;

  const gate = await mayOpen({
    ctx,
    store,
    type,
    openerId: input.openerId,
    now: clockOf(deps),
    deps,
    priority: input.priority,
    skipMemberLimits: input.skipMemberLimits,
  });

  if (!gate.ok) {
    return {
      status: 'refused',
      humanReason: gate.humanReason,
      ...(gate.authored ? { authored: true } : {}),
    };
  }

  const ticket = await store.reserve({
    guildId: ctx.guildId,
    typeId: type.id,
    panelId: input.panelId,
    openerId: input.openerId,
    priority: input.priority ?? type.defaultPriority,
    subject: input.subject ?? undefined,
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.source === undefined ? {} : { source: input.source }),
  });

  if (input.source !== undefined && ticket.channelId !== ticket.id) return { status: 'duplicate' };

  if (!input.skipMemberLimits) {
    // Re-checked now that the row exists. mayOpen ran before the insert, so two presses a moment
    // apart both saw room; whichever landed second is the one that stands down.
    const crowded = await overCap(input, ticket);

    if (crowded !== null) {
      await store.abandon(ctx.guildId, ticket.id);
      return { status: 'refused', humanReason: crowded };
    }
  }

  const staffRoleIds = staffRolesFor(ctx.config, type);

  const overwrites: PermissionOverwriteSpec[] = ticketOverwrites({
    guildId: ctx.guildId,
    ownerId,
    staffRoleIds,
    botUserId: deps.botUserId,
    participantIds: input.participantIds ?? [],
  });

  const namePattern = type.namePattern ?? ctx.config.namePattern;
  const naming = placeholderReads(ctx, deps, ticketSourcesFor(TICKET_NAME_SURFACE, [namePattern]));
  const nameFacts = {
    number: ticket.number,
    typeName: type.name,
    ownerId,
    legacyUserName: ownerId === input.openerId ? input.openerName : await nameOf(deps, ownerId),
    owner: await readProfile(naming, ownerId, naming.sources.owner),
    server: await readServer(naming),
  };

  const made = await makeChannel(input, ticket, {
    name: renderTicketChannelName(namePattern, nameFacts, clockOf(deps).getTime()),
    overwrites,
  });

  if (!made.ok) return made.outcome;

  const channelId = made.channelId;

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
        `Your ticket channel <#${channelId}> is open, but I lost track of it, so ` +
        `\`${labelOf(ctx, 'ticket', 'close')}\` won’t work there. Ask staff to delete the ` +
        'channel when you’re done.',
    };
  }

  await store.addParticipant(attached.id, ownerId, 'opener', null);

  for (const userId of input.participantIds ?? []) {
    if (userId === ownerId) continue;
    await store.addParticipant(attached.id, userId, 'added', input.openerId);
  }

  if (input.answers?.length) await store.saveAnswers(attached.id, input.answers);

  await store.recordEvent({
    ticketId: attached.id,
    guildId: ctx.guildId,
    type: 'created',
    actorId: input.openerId,
    data: {
      typeId: type.id,
      panelId: input.panelId,
      priority: attached.priority,
      ...(attached.source ? { source: attached.source } : {}),
    },
  });

  const view: TicketView = {
    ticket: attached,
    type,
    typeName: type.name,
    staffRoleIds,
    answers: input.answers ?? [],
    participants: [],
    facts: await ticketFacts({
      ctx,
      deps,
      store,
      surface: TICKET_WELCOME_SURFACE,
      template: type.welcomeMessage,
      ticket: attached,
      typeName: type.name,
      answers: input.answers ?? [],
    }),
  };

  const welcome = buildWelcomeComponents(view, type.welcomeMessage, clockOf(deps).getTime());

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
    ...(attached.source ? { source: attached.source } : {}),
  });

  return { status: 'opened', ticket: attached };
}

interface ChannelPlan {
  name: string;
  overwrites: PermissionOverwriteSpec[];
}

type Made = { ok: true; channelId: string } | { ok: false; outcome: OpenOutcome };

function unconfirmed(input: OpenInput, ticket: Ticket, why: string): Made {
  input.ctx.logger.warn(
    `ticket #${ticket.number} for ${input.source?.module ?? 'another module'} ` +
      `${input.source?.ref ?? ''} may or may not have its channel yet: ${why}. The row is kept, so ` +
      'the next request for it looks for the channel by name before making another one.',
    { guildId: input.ctx.guildId, moduleId: MODULE_ID, ticketId: ticket.id },
  );

  return { ok: false, outcome: { status: 'pending', ticket } };
}

function ambiguous(result: ActionResult): boolean {
  const code = result.failure?.code ?? '';
  return code === 'transport_failure' || /^discord_5\d\d$/.test(code);
}

async function madeEarlier(input: OpenInput, ticket: Ticket, name: string): Promise<string | null> {
  const { ctx, deps, store } = input;
  if (!deps.guildState) return null;

  let state: GuildState | null;
  try {
    state = await deps.guildState.get(ctx.guildId);
  } catch {
    return null;
  }

  for (const channel of state?.channels.values() ?? []) {
    if (channel.name !== name) continue;

    const owned = channel.overwrites.some(
      (overwrite) => overwrite.type === OVERWRITE_MEMBER && overwrite.id === ticket.ownerId,
    );
    if (!owned || (await store.byChannel(ctx.guildId, channel.id))) continue;

    return channel.id;
  }

  return null;
}

async function makeChannel(input: OpenInput, ticket: Ticket, plan: ChannelPlan): Promise<Made> {
  const { ctx, store, type } = input;
  const sourced = input.source !== undefined;

  if (sourced) {
    const earlier = await madeEarlier(input, ticket, plan.name);
    if (earlier) return { ok: true, channelId: earlier };
  }

  let created: ActionResult;
  try {
    created = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_channel',
      actorId: input.openerId,
      reason: `ticket #${ticket.number} opened by ${input.openerName}`,
      // Keyed on the row every request for one source shares: a per-request key makes a second channel.
      idempotencyKey: sourced
        ? `${MODULE_ID}:source:${ticket.id}:create`
        : `${input.idempotencyKey}:create`,
      dryRun: false,
      record: false,
      payload: {
        name: plan.name,
        type: TEXT_CHANNEL_TYPE,
        ...(type.categoryId ? { parentId: type.categoryId } : {}),
        ...(input.subject ? { topic: input.subject.slice(0, 1024) } : {}),
        permissionOverwrites: plan.overwrites,
      },
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (sourced) return unconfirmed(input, ticket, `creating its channel threw ${why}`);

    // A throw here — a dead dedupe store, a dead REST proxy — would otherwise leave the reserved
    // row open forever, pointing at no channel and holding one of the member's slots.
    await store.abandon(ctx.guildId, ticket.id);

    ctx.logger.error(
      `ticket #${ticket.number} could not be opened for ${input.openerName}: creating its channel ` +
        `threw ${why}. The reserved row was removed, so the member can press the button again.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, ticketId: ticket.id },
    );

    return {
      ok: false,
      outcome: {
        status: 'refused',
        humanReason:
          'Something went wrong while I was opening your ticket, so nothing was saved. Try again. ' +
          'If a ticket channel appeared anyway, ask staff to delete it.',
      },
    };
  }

  // The create key is this press's own event id, so a duplicate claim means the gateway redelivered
  // it: the first delivery opened the channel and owns that ticket. Only the row this delivery
  // reserved goes — the attached one from the first delivery is left exactly as it is.
  if (created.status === 'skipped_duplicate') {
    // A sourced row is shared by every request for its source, so it is never one delivery's to drop.
    if (!sourced) await store.abandon(ctx.guildId, ticket.id);
    return { ok: false, outcome: { status: 'duplicate' } };
  }

  if (created.status !== 'executed') {
    if (sourced && ambiguous(created)) {
      return unconfirmed(input, ticket, failureOf(created, 'Discord did not answer'));
    }

    await store.abandon(ctx.guildId, ticket.id);

    return {
      ok: false,
      outcome: {
        status: 'refused',
        humanReason: `I couldn't open a ticket channel: ${failureOf(created, 'Discord refused it')}`,
      },
    };
  }

  const channelId = str(record(created.body)?.id);
  if (channelId) return { ok: true, channelId };

  if (sourced) return unconfirmed(input, ticket, 'Discord did not say which channel it made');

  await store.abandon(ctx.guildId, ticket.id);

  return {
    ok: false,
    outcome: {
      status: 'refused',
      humanReason:
        'Discord didn’t confirm which channel it created, so the ticket wasn’t saved. Try again.',
    },
  };
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
        `Ticket #${ticket.number} can’t be closed right now, so nothing was changed. It may have ` +
        'just been reopened or deleted.',
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

  const closerId =
    isProtonActor(input.closedBy) && deps.botUserId ? deps.botUserId : input.closedBy;

  const closing = await ticketFacts({
    ctx,
    deps,
    store,
    surface: TICKET_CLOSE_SURFACE,
    template: ctx.config.closeConfirmation,
    ticket: closed,
    typeName: type?.name ?? closed.typeId,
    close: { closedById: closerId, reason: input.reason },
    actor: { id: closerId },
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
      content: renderTicketText(
        TICKET_CLOSE_SURFACE,
        ctx.config.closeConfirmation,
        closing,
        clockOf(deps).getTime(),
      ),
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
    ...(closed.source ? { source: closed.source } : {}),
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
    const other = ticket.source
      ? await store.bySource(ctx.guildId, ticket.source.module, ticket.source.ref)
      : null;

    return {
      ok: false,
      humanReason:
        other && other.id !== ticket.id && other.status === 'open'
          ? `Ticket #${ticket.number} can’t be reopened while ticket #${other.number} is open ` +
            'for the same request. Use that one instead.'
          : `Ticket #${ticket.number} isn’t closed, so there’s nothing to reopen.`,
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
    // A nonce per attempt: a deduped create_dm has no body, so a replay would ask in the channel.
    idempotencyKey: `${MODULE_ID}:rating-dm:${ticket.id}:${closeCycle(ticket)}:${newId()}`,
    dryRun: false,
    record: false,
    payload: { userId: ticket.ownerId },
  });

  const target = (dm.status === 'executed' ? str(record(dm.body)?.id) : null) ?? ticket.channelId;

  const addressed = {
    type: ComponentType.TextDisplay,
    content: `<@${ticket.ownerId}>, I couldn't DM you, so I'm asking here.`,
  };

  const ask = (channelId: string): Promise<ActionResult> => {
    const shared = channelId === ticket.channelId;

    return ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: MODULE_ID,
      // One key for the DM and the channel fallback: a separate key posts twice on a replayed close.
      idempotencyKey: `${MODULE_ID}:rating:${ticket.id}:${closeCycle(ticket)}`,
      dryRun: false,
      record: false,
      payload: {
        channelId,
        components: shared ? [addressed, ...components.value] : components.value,
        flags: 32768,
        allowedMentions: shared ? { parse: [], users: [ticket.ownerId] } : { parse: [] },
        directMessage: !shared,
      },
    });
  };

  let asked = await ask(target);

  if (target !== ticket.channelId && dmUndelivered(asked)) asked = await ask(ticket.channelId);

  if (refused(asked)) {
    ctx.logger.info(
      `ticket #${ticket.number} closed without asking for a rating: ${failureOf(asked, 'Discord refused it')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

function dmUndelivered(result: ActionResult): boolean {
  return result.failure?.code === 'discord_403';
}
