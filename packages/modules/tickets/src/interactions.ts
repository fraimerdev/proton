import {
  deferEphemeral,
  deferUpdate,
  type EventListener,
  type EventType,
  encodeCustomId,
  followUp,
  type InteractionBase,
  interactionRef,
  MESSAGE_FLAG_EPHEMERAL,
  type ModuleContext,
  openModal,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  readMemberPermissions,
  readModalInteraction,
  replyEphemeral,
  TICKET_PRIORITIES,
  type TicketPriority,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { authorizeTicket, type TicketAction, type TicketActor } from './authorize.ts';
import {
  CATEGORY_CHANNEL_TYPE,
  MODULE_ID,
  panelFor,
  staffRolesFor,
  type TicketsConfig,
  type TicketType,
  typeFor,
  typesOf,
} from './config.ts';
import {
  addParticipant,
  assign,
  type ControlInput,
  type ControlOutcome,
  claim,
  defaultName,
  move,
  removeParticipant,
  rename,
  requestClose,
  setLock,
  setPriority,
  unclaim,
} from './controls.ts';
import { bindButton, type TicketsDeps } from './deps.ts';
import {
  ADD_ACTION,
  ASSIGN_ACTION,
  buildCloseRequestComponents,
  buildControlRows,
  buildInfoComponents,
  buildOptionRows,
  buildWelcomeComponents,
  CLAIM_ACTION,
  CLOSE_ACTION,
  CLOSE_CANCEL_ACTION,
  CLOSE_CONFIRM_ACTION,
  CLOSE_REASON_ACTION,
  DELETE_ACTION,
  DELETE_CONFIRM_ACTION,
  FORM_ACTION,
  INFO_ACTION,
  LOCK_ACTION,
  MOVE_ACTION,
  OPEN_ACTION,
  OPEN_TYPE_ACTION,
  OPTIONS_ACTION,
  PRIORITY_ACTION,
  RATE_ACTION,
  REMOVE_ACTION,
  REOPEN_ACTION,
  SELECT_TYPE_ACTION,
  type TicketView,
  TRANSCRIPT_ACTION,
  UNCLAIM_ACTION,
  UNLOCK_ACTION,
} from './interface.ts';
import { closeTicket, deleteTicket, openTicket, reopenTicket } from './lifecycle.ts';
import {
  buildCloseReasonModal,
  buildIntakeModal,
  buildRatingCommentModal,
  buildRenameModal,
  COMMENT_FIELD,
  NAME_FIELD,
  needsModal,
  RATE_COMMENT_ACTION,
  REASON_FIELD,
  RENAME_ACTION,
  readIntakeAnswers,
} from './modal.ts';
import type { Ticket, TicketStore } from './store.ts';
import { buildTranscript } from './transcript-delivery.ts';

export const TICKET_INTERACTION_EVENT_TYPES: EventType[] = [
  'interaction.component',
  'interaction.modal',
];

export const ADD_SELECT_ACTION = 'addsel';
export const REMOVE_SELECT_ACTION = 'remsel';
export const ASSIGN_SELECT_ACTION = 'asgsel';
export const MOVE_SELECT_ACTION = 'movsel';

export type OpenPress = { panelId: string };

// Kept at exactly one argument forever. Panels are posted, never re-rendered, and no message id is
// stored, so every panel already sitting in a guild breaks the moment this shape changes.
export function readOpenPress(customId: unknown): OpenPress | null {
  const parsed = parseCustomId(customId);
  const panelId = parsed?.args.length === 1 ? parsed.args[0] : undefined;

  if (!parsed || parsed.moduleId !== MODULE_ID || parsed.action !== OPEN_ACTION || !panelId) {
    return null;
  }

  return { panelId };
}

export type PressOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'opened'; channelId: string }
  | { action: 'done'; reason: string }
  | { action: 'refused'; reason: string };

interface Facts extends InteractionBase {
  customId: string;
  values: string[];
  fields: Record<string, string>;
  selected: Record<string, string[]>;
  messageId: string | null;
  messageFlags: number | null;
}

function readFacts(event: ProtonEvent): Facts | null {
  if (event.type === 'interaction.modal') {
    const modal = readModalInteraction(event);
    if (!modal) return null;

    // A modal submit carries no message, so nothing refreshes the panel it was opened from — the
    // control rows are rebuilt on the next press instead.
    return { ...modal, values: [], selected: modal.values, messageId: null, messageFlags: null };
  }

  const component = readComponentInteraction(event);
  if (!component) return null;

  return { ...component, fields: {}, selected: {} };
}

function actorOf(event: ProtonEvent, facts: Facts): TicketActor {
  return {
    userId: facts.userId,
    roleIds: facts.roleIds ?? [],
    permissions: readMemberPermissions(event),
  };
}

interface Session {
  ctx: ModuleContext<TicketsConfig>;
  deps: TicketsDeps;
  store: TicketStore;
  facts: Facts;
  actor: TicketActor;
  event: ProtonEvent;
  to: {
    guildId: string;
    moduleId: string;
    actorId: string;
    interaction: ReturnType<typeof interactionRef>;
    idempotencyKey: string;
  };
  applicationId: string;
}

async function say(session: Session, content: string, root = 'reply'): Promise<void> {
  const result = await session.ctx.executor.execute(
    followUp(
      {
        ...session.to,
        idempotencyKey: `${session.to.idempotencyKey}:${root}`,
        applicationId: session.applicationId,
      },
      content,
    ),
  );

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    session.ctx.logger.error(
      `a member used a ticket control and could not be told what happened: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      { guildId: session.ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function show(
  session: Session,
  components: Record<string, unknown>[],
  root: string,
): Promise<void> {
  await session.ctx.executor.execute(
    followUp(
      {
        ...session.to,
        idempotencyKey: `${session.to.idempotencyKey}:${root}`,
        applicationId: session.applicationId,
      },
      { components, flags: 32768 | 64, ephemeral: true },
    ),
  );
}

async function viewOf(session: Session, ticket: Ticket): Promise<TicketView> {
  const type = typeFor(session.ctx.config, ticket.typeId);

  return {
    ticket,
    type,
    typeName: type?.name ?? ticket.typeId,
    staffRoleIds: staffRolesFor(session.ctx.config, type),
    answers: await session.store.listAnswers(ticket.id),
    participants: await session.store.listParticipants(ticket.id),
  };
}

async function ticketHere(session: Session): Promise<Ticket | null> {
  const channelId = session.facts.channelId;
  if (!channelId) return null;

  return session.store.byChannel(session.ctx.guildId, channelId);
}

function gate(
  session: Session,
  action: TicketAction,
  ticket: Ticket | null,
): { ok: true } | { ok: false; humanReason: string } {
  const type = ticket ? typeFor(session.ctx.config, ticket.typeId) : undefined;

  const decision = authorizeTicket({
    action,
    actor: session.actor,
    ticket,
    staffRoleIds: staffRolesFor(session.ctx.config, type),
    ...(type ? { claimMode: type.claimMode, claimRestrictsStaff: type.claimRestrictsReplies } : {}),
    ...(type ? { reopenEnabled: type.reopenEnabled } : {}),
  });

  return decision.allowed ? { ok: true } : { ok: false, humanReason: decision.humanReason };
}

function controlInput(session: Session, ticket: Ticket): ControlInput {
  return {
    ctx: session.ctx,
    store: session.store,
    deps: session.deps,
    ticket,
    actorId: session.actor.userId,
    idempotencyKey: session.to.idempotencyKey,
  };
}

// Refreshes the control panel the press came from, so Claim becomes Unclaim and a locked ticket
// stops offering Lock. Best effort: the action already happened and a stale panel is not a reason
// to tell the member it failed.
async function refresh(session: Session, ticket: Ticket): Promise<void> {
  if (!session.facts.messageId) return;

  // The Options submenu lives on an ephemeral followup, which only the interaction webhook can
  // edit. Patching it by channel and message id is a guaranteed 404 and would leave the welcome
  // panel stale anyway, so the press that came from one refreshes nothing.
  if (((session.facts.messageFlags ?? 0) & MESSAGE_FLAG_EPHEMERAL) !== 0) return;

  const view = await viewOf(session, ticket);
  const controls = buildControlRows(view);
  if (!controls.ok) return;

  const welcome = buildWelcomeComponents(
    view,
    typeFor(session.ctx.config, ticket.typeId)?.welcomeMessage ?? '',
  );

  if (!welcome.ok) return;

  await session.ctx.executor.execute({
    guildId: session.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: session.actor.userId,
    idempotencyKey: `${session.to.idempotencyKey}:refresh`,
    dryRun: false,
    record: false,
    payload: {
      channelId: ticket.channelId,
      messageId: session.facts.messageId,
      components: welcome.value,
      flags: 32768,
    },
  });
}

async function reportControl(
  session: Session,
  outcome: ControlOutcome,
  root: string,
): Promise<PressOutcome> {
  if (!outcome.ok) {
    await say(session, outcome.humanReason, root);
    return { action: 'refused', reason: outcome.humanReason };
  }

  await say(session, outcome.message, root);
  await refresh(session, outcome.ticket);

  return { action: 'done', reason: outcome.message };
}

export async function handleTicketInteraction(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
  deps: TicketsDeps,
): Promise<PressOutcome> {
  const facts = readFacts(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const parsed = parseCustomId(facts.customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) {
    return { action: 'ignored', reason: 'the component does not belong to tickets' };
  }

  const bound = bindButton(deps);
  if ('unbound' in bound) {
    ctx.logger.error(
      `Tickets is enabled in this server but its controls are NOT running: the module was built ` +
        `without ${bound.unbound.join(', ')}.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'refused', reason: 'the module is not fully wired' };
  }

  const session: Session = {
    ctx,
    deps,
    store: bound.store,
    facts,
    actor: actorOf(event, facts),
    event,
    applicationId: bound.applicationId,
    to: {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      actorId: facts.userId,
      interaction: interactionRef(facts),
      idempotencyKey: `${MODULE_ID}:${event.id}`,
    },
  };

  return dispatch(session, parsed.action, parsed.args);
}

async function dispatch(session: Session, action: string, args: string[]): Promise<PressOutcome> {
  switch (action) {
    case OPEN_ACTION:
      return startOpen(session, args[0] ?? '', null);
    case OPEN_TYPE_ACTION:
      return startOpen(session, args[0] ?? '', args[1] ?? '');
    case SELECT_TYPE_ACTION:
      return startOpen(session, args[0] ?? '', session.facts.values[0] ?? '');
    case FORM_ACTION:
      return submitForm(session, args[0] ?? '', args[1] ?? '');

    case CLOSE_ACTION:
      return pressClose(session);
    case CLOSE_REASON_ACTION:
      return performClose(session, session.facts.fields[REASON_FIELD] ?? null);
    case CLOSE_CONFIRM_ACTION:
      return confirmClose(session, true);
    case CLOSE_CANCEL_ACTION:
      return confirmClose(session, false);

    case CLAIM_ACTION:
      return runControl(session, 'claim', (input) => claim(input));
    case UNCLAIM_ACTION:
      return runControl(session, 'unclaim', (input) => unclaim(input));

    case LOCK_ACTION:
      return runControl(session, 'lock', (input) => setLock(input, true));
    case UNLOCK_ACTION:
      return runControl(session, 'unlock', (input) => setLock(input, false));

    case PRIORITY_ACTION:
      return pressPriority(session);

    case ADD_ACTION:
      return pickMember(session, true);
    case REMOVE_ACTION:
      return pickMember(session, false);
    case ADD_SELECT_ACTION:
      return runControl(session, 'add-participant', (input) =>
        addParticipant(input, session.facts.values[0] ?? ''),
      );
    case REMOVE_SELECT_ACTION:
      return runControl(session, 'remove-participant', (input) =>
        removeParticipant(input, session.facts.values[0] ?? ''),
      );

    case ASSIGN_ACTION:
      return pickTarget(session, 'assign');
    case ASSIGN_SELECT_ACTION:
      return runControl(session, 'assign', (input) =>
        assign(input, session.facts.values[0] ?? null),
      );
    case MOVE_ACTION:
      return pickTarget(session, 'move');
    case MOVE_SELECT_ACTION:
      return runControl(session, 'move', (input) => move(input, session.facts.values[0] ?? ''));

    case 'rename':
      return pressRename(session);
    case RENAME_ACTION:
      return runControl(session, 'rename', (input) =>
        rename(input, session.facts.fields[NAME_FIELD] ?? ''),
      );

    case INFO_ACTION:
      return pressInfo(session);
    case OPTIONS_ACTION:
      return pressOptions(session);
    case TRANSCRIPT_ACTION:
      return pressTranscript(session);

    case REOPEN_ACTION:
      return pressReopen(session);
    case DELETE_ACTION:
      return pressDelete(session, false);
    case DELETE_CONFIRM_ACTION:
      return pressDelete(session, true);

    case RATE_ACTION:
      return pressRate(session, args[0] ?? '', Number(args[1] ?? '0'));
    case RATE_COMMENT_ACTION:
      return submitRating(session, args[0] ?? '', Number(args[1] ?? '0'));

    default:
      return { action: 'ignored', reason: `no ticket control answers to '${action}'` };
  }
}

async function startOpen(
  session: Session,
  panelId: string,
  typeId: string | null,
): Promise<PressOutcome> {
  const { ctx } = session;

  const panel = panelFor(ctx.config, panelId);
  if (!panel) {
    await session.ctx.executor.execute(
      replyEphemeral(
        session.to,
        'That button belongs to a ticket panel that no longer exists in this server’s settings, ' +
          'so nothing was opened. An admin can repost the panel from the Proton dashboard.',
      ),
    );
    return { action: 'refused', reason: 'the panel is gone' };
  }

  const available = typesOf(ctx.config, panel);

  const chosen =
    typeId === null || typeId === ''
      ? available.length === 1
        ? available[0]
        : undefined
      : available.find((type) => type.id === typeId);

  if (!chosen) {
    const message =
      available.length === 0
        ? 'That panel has no ticket types attached to it any more, so there is nothing to open. ' +
          'An admin can fix it in the Proton dashboard under Tickets.'
        : 'That option is no longer one this panel offers. An admin can repost the panel from the ' +
          'Proton dashboard so its buttons match the settings again.';

    await session.ctx.executor.execute(replyEphemeral(session.to, message));
    return { action: 'refused', reason: 'the ticket type is gone' };
  }

  // A modal must be the very first response — it cannot follow a deferral — so the form path
  // answers here and finishes in submitForm().
  if (needsModal(chosen)) {
    const modal = buildIntakeModal(panel.id, chosen);

    if (modal) {
      await session.ctx.executor.execute(openModal(session.to, modal));
      return { action: 'done', reason: 'asked the member to fill in the form' };
    }
  }

  await session.ctx.executor.execute(deferEphemeral(session.to));

  return finishOpen(session, panel.id, chosen, {
    answers: [],
    priority: undefined,
    subject: null,
  });
}

async function submitForm(
  session: Session,
  panelId: string,
  typeId: string,
): Promise<PressOutcome> {
  const panel = panelFor(session.ctx.config, panelId);
  const type = panel
    ? typesOf(session.ctx.config, panel).find((entry) => entry.id === typeId)
    : undefined;

  if (!panel || !type) {
    await session.ctx.executor.execute(
      replyEphemeral(
        session.to,
        'The ticket type you filled that form in for has been removed from this server’s ' +
          'settings, so nothing was opened and nothing was recorded.',
      ),
    );
    return { action: 'refused', reason: 'the ticket type is gone' };
  }

  await session.ctx.executor.execute(deferEphemeral(session.to));

  const read = readIntakeAnswers(type, session.facts.fields, session.facts.selected);

  return finishOpen(session, panel.id, type, {
    answers: read.answers,
    priority: read.priority ?? undefined,
    subject: read.subject,
  });
}

async function finishOpen(
  session: Session,
  panelId: string,
  type: TicketType,
  intake: {
    answers: ReturnType<typeof readIntakeAnswers>['answers'];
    priority: TicketPriority | undefined;
    subject: string | null;
  },
): Promise<PressOutcome> {
  const opened = await openTicket({
    ctx: session.ctx,
    store: session.store,
    deps: session.deps,
    type,
    panelId,
    openerId: session.actor.userId,
    openerName:
      (await session.deps
        .displayName?.(session.actor.userId)
        .then((name) => name ?? session.actor.userId)
        .catch(() => session.actor.userId)) ?? session.actor.userId,
    idempotencyKey: session.to.idempotencyKey,
    answers: intake.answers,
    priority: intake.priority,
    subject: intake.subject,
  });

  if (opened.status === 'duplicate') {
    return { action: 'ignored', reason: 'an earlier delivery of this press already opened it' };
  }

  if (opened.status === 'refused') {
    await say(session, opened.humanReason, 'refused');
    return { action: 'refused', reason: opened.humanReason };
  }

  await say(
    session,
    `Opened ticket #${opened.ticket.number} — <#${opened.ticket.channelId}>. ` +
      'Everything you say there is visible only to you and the support team.',
    'opened',
  );

  return { action: 'opened', channelId: opened.ticket.channelId };
}

async function runControl(
  session: Session,
  action: TicketAction,
  run: (input: ControlInput) => Promise<ControlOutcome>,
): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, action, ticket);

  if (!allowed.ok) {
    await say(session, allowed.humanReason, 'refused');
    return { action: 'refused', reason: allowed.humanReason };
  }

  if (!ticket) {
    await say(session, 'There is no ticket attached to this channel any more.', 'refused');
    return { action: 'refused', reason: 'no ticket here' };
  }

  return reportControl(session, await run(controlInput(session, ticket)), action);
}

async function pressClose(session: Session): Promise<PressOutcome> {
  const ticket = await ticketHere(session);
  const allowed = gate(session, 'close', ticket);

  if (!allowed.ok || !ticket) {
    await session.ctx.executor.execute(
      replyEphemeral(
        session.to,
        allowed.ok ? 'There is no ticket attached to this channel any more.' : allowed.humanReason,
      ),
    );
    return { action: 'refused', reason: allowed.ok ? 'no ticket here' : allowed.humanReason };
  }

  const modal = buildCloseReasonModal();

  if (!modal) {
    await session.ctx.executor.execute(deferUpdate(session.to));
    return performClose(session, null);
  }

  await session.ctx.executor.execute(openModal(session.to, modal));
  return { action: 'done', reason: 'asked why it is being closed' };
}

async function performClose(session: Session, reason: string | null): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, 'close', ticket);

  if (!allowed.ok || !ticket) {
    await say(
      session,
      allowed.ok ? 'There is no ticket here any more.' : allowed.humanReason,
      'refused',
    );
    return { action: 'refused', reason: 'not permitted' };
  }

  const type = typeFor(session.ctx.config, ticket.typeId);

  // Staff asking to close somebody else's ticket goes through the member first when the type says
  // so; the member closing their own never does, because they are the one being asked.
  if (type?.closeRequiresConfirmation && session.actor.userId !== ticket.ownerId) {
    const outcome = await requestClose(controlInput(session, ticket), reason);

    if (!outcome.ok) {
      await say(session, outcome.humanReason, 'refused');
      return { action: 'refused', reason: outcome.humanReason };
    }

    const components = buildCloseRequestComponents(ticket, session.actor.userId, reason);

    if (components.ok) {
      await session.ctx.executor.execute({
        guildId: session.ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'send',
        actorId: session.actor.userId,
        // Keyed on when the request was recorded, not on now(): a redelivered press must collapse
        // into the first ask, while a genuine second request after a decline must be a new message.
        idempotencyKey: `${MODULE_ID}:close-request:${ticket.id}:${(outcome.ticket.closeRequestedAt ?? outcome.ticket.openedAt).getTime()}`,
        dryRun: false,
        record: false,
        payload: {
          channelId: ticket.channelId,
          components: components.value,
          flags: 32768,
          allowedMentions: { parse: [], users: [ticket.ownerId] },
        },
      });
    }

    await say(session, outcome.message, 'requested');
    return { action: 'done', reason: outcome.message };
  }

  const closed = await closeTicket({
    ctx: session.ctx,
    store: session.store,
    deps: session.deps,
    ticket,
    closedBy: session.actor.userId,
    reason,
    idempotencyKey: session.to.idempotencyKey,
  });

  if (!closed.ok) {
    await say(session, closed.humanReason, 'refused');
    return { action: 'refused', reason: closed.humanReason };
  }

  await say(session, `Closed ticket #${closed.ticket.number}.`, 'closed');
  await refresh(session, closed.ticket);

  return { action: 'done', reason: 'closed' };
}

async function confirmClose(session: Session, confirmed: boolean): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);

  if (!ticket || ticket.closeRequestedAt === null) {
    await say(session, 'There is no open request to close this ticket.', 'refused');
    return { action: 'refused', reason: 'no close request pending' };
  }

  // Only the member being asked, or staff who could have closed it outright, may answer.
  const mayAnswer = session.actor.userId === ticket.ownerId || gate(session, 'close', ticket).ok;

  if (!mayAnswer) {
    await say(session, 'That question is for the member who raised this ticket.', 'refused');
    return { action: 'refused', reason: 'not the ticket owner' };
  }

  if (!confirmed) {
    const cleared = await session.store.clearCloseRequest(session.ctx.guildId, ticket.id);

    if (cleared) {
      await session.store.recordEvent({
        ticketId: ticket.id,
        guildId: session.ctx.guildId,
        type: 'close-request-declined',
        actorId: session.actor.userId,
      });
    }

    await say(session, 'Kept open. Tell the team what is still wrong.', 'kept');
    return { action: 'done', reason: 'close request declined' };
  }

  const closed = await closeTicket({
    ctx: session.ctx,
    store: session.store,
    deps: session.deps,
    ticket,
    closedBy: session.actor.userId,
    reason: ticket.closeRequestedById
      ? `confirmed by the member after <@${ticket.closeRequestedById}> asked`
      : 'confirmed by the member',
    idempotencyKey: session.to.idempotencyKey,
  });

  if (!closed.ok) {
    await say(session, closed.humanReason, 'refused');
    return { action: 'refused', reason: closed.humanReason };
  }

  await say(session, `Closed ticket #${closed.ticket.number}. Thanks for confirming.`, 'closed');
  return { action: 'done', reason: 'closed' };
}

async function pressPriority(session: Session): Promise<PressOutcome> {
  const chosen = session.facts.values[0] ?? '';

  if (!(TICKET_PRIORITIES as readonly string[]).includes(chosen)) {
    return { action: 'ignored', reason: 'that is not a priority this build knows' };
  }

  return runControl(session, 'priority', (input) => setPriority(input, chosen as TicketPriority));
}

async function pickMember(session: Session, adding: boolean): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const action: TicketAction = adding ? 'add-participant' : 'remove-participant';
  const allowed = gate(session, action, ticket);

  if (!allowed.ok || !ticket) {
    await say(
      session,
      allowed.ok ? 'There is no ticket here any more.' : allowed.humanReason,
      'refused',
    );
    return { action: 'refused', reason: 'not permitted' };
  }

  const encoded = encodeCustomId(MODULE_ID, adding ? ADD_SELECT_ACTION : REMOVE_SELECT_ACTION);
  if (!encoded.ok) return { action: 'refused', reason: encoded.humanReason };

  await show(
    session,
    [
      {
        type: ComponentType.TextDisplay,
        content: adding
          ? '### Who should be able to see this ticket?'
          : '### Who should lose access to this ticket?',
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.UserSelect,
            custom_id: encoded.customId,
            placeholder: adding ? 'Choose a member to add…' : 'Choose a member to remove…',
            max_values: 1,
          },
        ],
      },
    ],
    adding ? 'add-picker' : 'remove-picker',
  );

  return { action: 'done', reason: 'asked which member' };
}

async function pickTarget(session: Session, action: 'assign' | 'move'): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, action, ticket);

  if (!allowed.ok || !ticket) {
    await say(
      session,
      allowed.ok ? 'There is no ticket here any more.' : allowed.humanReason,
      'refused',
    );
    return { action: 'refused', reason: 'not permitted' };
  }

  const encoded = encodeCustomId(
    MODULE_ID,
    action === 'assign' ? ASSIGN_SELECT_ACTION : MOVE_SELECT_ACTION,
  );

  if (!encoded.ok) return { action: 'refused', reason: encoded.humanReason };

  await show(
    session,
    [
      {
        type: ComponentType.TextDisplay,
        content:
          action === 'assign'
            ? '### Who should own answering this ticket?'
            : '### Which category should this ticket live in?',
      },
      {
        type: ComponentType.ActionRow,
        components: [
          action === 'assign'
            ? {
                type: ComponentType.UserSelect,
                custom_id: encoded.customId,
                placeholder: 'Choose a staff member…',
                max_values: 1,
              }
            : {
                type: ComponentType.ChannelSelect,
                custom_id: encoded.customId,
                placeholder: 'Choose a category…',
                channel_types: [CATEGORY_CHANNEL_TYPE],
                max_values: 1,
              },
        ],
      },
    ],
    `${action}-picker`,
  );

  return { action: 'done', reason: `asked which ${action === 'assign' ? 'member' : 'category'}` };
}

async function pressRename(session: Session): Promise<PressOutcome> {
  const ticket = await ticketHere(session);
  const allowed = gate(session, 'rename', ticket);

  if (!allowed.ok || !ticket) {
    await session.ctx.executor.execute(
      replyEphemeral(
        session.to,
        allowed.ok ? 'There is no ticket attached to this channel.' : allowed.humanReason,
      ),
    );
    return { action: 'refused', reason: 'not permitted' };
  }

  const modal = buildRenameModal(defaultName(session.ctx, ticket));
  if (!modal) return { action: 'refused', reason: 'the rename form could not be built' };

  await session.ctx.executor.execute(openModal(session.to, modal));
  return { action: 'done', reason: 'asked for the new name' };
}

async function pressInfo(session: Session): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, 'info', ticket);

  if (!allowed.ok || !ticket) {
    await say(session, allowed.ok ? 'There is no ticket here.' : allowed.humanReason, 'refused');
    return { action: 'refused', reason: 'not permitted' };
  }

  const view = await viewOf(session, ticket);
  const rating = await session.store.getRating(ticket.id);

  await show(
    session,
    buildInfoComponents(view, {
      messageCount: ticket.messageCount,
      rating: rating?.rating ?? null,
    }),
    'info',
  );

  return { action: 'done', reason: 'showed the ticket' };
}

async function pressOptions(session: Session): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, 'priority', ticket);

  if (!allowed.ok || !ticket) {
    await say(session, allowed.ok ? 'There is no ticket here.' : allowed.humanReason, 'refused');
    return { action: 'refused', reason: 'not permitted' };
  }

  const rows = buildOptionRows(await viewOf(session, ticket));
  if (!rows.ok) {
    await say(session, rows.humanReason, 'refused');
    return { action: 'refused', reason: rows.humanReason };
  }

  await show(
    session,
    [{ type: ComponentType.TextDisplay, content: `### Ticket #${ticket.number}` }, ...rows.value],
    'options',
  );

  return { action: 'done', reason: 'showed the options' };
}

async function pressTranscript(session: Session): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, 'transcript', ticket);

  if (!allowed.ok || !ticket) {
    await say(session, allowed.ok ? 'There is no ticket here.' : allowed.humanReason, 'refused');
    return { action: 'refused', reason: 'not permitted' };
  }

  const built = await buildTranscript({
    ctx: session.ctx,
    store: session.store,
    deps: session.deps,
    ticket,
    type: typeFor(session.ctx.config, ticket.typeId),
    actorId: session.actor.userId,
  });

  const result = await session.ctx.executor.execute(
    followUp(
      {
        ...session.to,
        idempotencyKey: `${session.to.idempotencyKey}:transcript`,
        applicationId: session.applicationId,
      },
      {
        content: `Transcript of ticket #${ticket.number}, as it stands right now.`,
        files: [
          {
            filename: built.filename,
            contentType: 'text/html',
            data: new TextEncoder().encode(built.html),
            description: `Transcript of ticket #${ticket.number}`,
          },
        ],
        ephemeral: true,
      },
    ),
  );

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await say(
      session,
      `I built the transcript but could not send it: ${result.failure?.humanReason ?? 'unknown reason'}`,
      'transcript-failed',
    );
  }

  return { action: 'done', reason: 'sent the transcript' };
}

async function pressReopen(session: Session): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, 'reopen', ticket);

  if (!allowed.ok || !ticket) {
    await say(session, allowed.ok ? 'There is no ticket here.' : allowed.humanReason, 'refused');
    return { action: 'refused', reason: 'not permitted' };
  }

  const reopened = await reopenTicket(session.ctx, session.store, ticket, session.actor.userId);

  if (!reopened.ok) {
    await say(session, reopened.humanReason, 'refused');
    return { action: 'refused', reason: reopened.humanReason };
  }

  await say(session, `Reopened ticket #${reopened.ticket.number}.`, 'reopened');
  await refresh(session, reopened.ticket);

  return { action: 'done', reason: 'reopened' };
}

async function pressDelete(session: Session, confirmed: boolean): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  const ticket = await ticketHere(session);
  const allowed = gate(session, 'delete', ticket);

  if (!allowed.ok || !ticket) {
    await say(session, allowed.ok ? 'There is no ticket here.' : allowed.humanReason, 'refused');
    return { action: 'refused', reason: 'not permitted' };
  }

  if (!confirmed) {
    const encoded = encodeCustomId(MODULE_ID, DELETE_CONFIRM_ACTION);
    if (!encoded.ok) return { action: 'refused', reason: encoded.humanReason };

    await show(
      session,
      [
        {
          type: ComponentType.TextDisplay,
          content:
            `### Delete ticket #${ticket.number}?\nThis removes the channel and everything said ` +
            'in it, and it cannot be undone.',
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: 4,
              label: 'Delete it',
              custom_id: encoded.customId,
            },
          ],
        },
      ],
      'delete-confirm',
    );

    return { action: 'done', reason: 'asked for confirmation' };
  }

  const removed = await deleteTicket(
    session.ctx,
    session.store,
    session.deps,
    ticket,
    session.actor.userId,
    null,
  );

  if (!removed.ok) {
    await say(session, removed.humanReason, 'refused');
    return { action: 'refused', reason: removed.humanReason };
  }

  return { action: 'done', reason: 'deleted' };
}

async function pressRate(session: Session, ticketId: string, score: number): Promise<PressOutcome> {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return { action: 'ignored', reason: 'that is not a rating between one and five' };
  }

  const modal = buildRatingCommentModal(ticketId, score);

  if (!modal) {
    await session.ctx.executor.execute(deferUpdate(session.to));
    return saveRating(session, ticketId, score, null);
  }

  await session.ctx.executor.execute(openModal(session.to, modal));
  return { action: 'done', reason: 'asked for a comment' };
}

async function submitRating(
  session: Session,
  ticketId: string,
  score: number,
): Promise<PressOutcome> {
  await session.ctx.executor.execute(deferUpdate(session.to));

  return saveRating(session, ticketId, score, session.facts.fields[COMMENT_FIELD] || null);
}

async function saveRating(
  session: Session,
  ticketId: string,
  score: number,
  comment: string | null,
): Promise<PressOutcome> {
  const ticket = await session.store.get(session.ctx.guildId, ticketId);

  // The rating button can arrive by DM, where the channel says nothing about which guild or ticket
  // it belongs to, so the owner check is the only thing standing between a stranger and the score.
  if (!ticket || ticket.ownerId !== session.actor.userId) {
    await say(session, 'That rating is not yours to give.', 'refused');
    return { action: 'refused', reason: 'not the ticket owner' };
  }

  const saved = await session.store.saveRating({
    ticketId,
    guildId: session.ctx.guildId,
    userId: session.actor.userId,
    rating: score,
    comment,
  });

  await say(
    session,
    saved
      ? `Thank you — ${score} out of 5 recorded for ticket #${ticket.number}.`
      : 'You have already rated this ticket.',
    'rated',
  );

  return { action: 'done', reason: saved ? 'rating saved' : 'already rated' };
}

export function createTicketInteractionListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_INTERACTION_EVENT_TYPES,

    async handler(event, ctx) {
      // Answered rather than dropped: a silent return leaves Discord showing "This interaction
      // failed", which reads as a broken bot rather than a switched-off module.
      if (!ctx.config.enabled) {
        const facts = readFacts(event);
        const parsed = facts ? parseCustomId(facts.customId) : null;
        if (!facts || parsed?.moduleId !== MODULE_ID) return;

        await ctx.executor.execute(
          replyEphemeral(
            {
              guildId: ctx.guildId,
              moduleId: MODULE_ID,
              actorId: facts.userId,
              interaction: interactionRef(facts),
              idempotencyKey: `${MODULE_ID}:${event.id}`,
            },
            'Tickets is switched off in this server, so that button does nothing. An admin can ' +
              'turn it back on in the Proton dashboard.',
          ),
        );
        return;
      }

      await handleTicketInteraction(event, ctx, deps);
    },
  };
}
