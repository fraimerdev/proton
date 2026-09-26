import {
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  errorStatus,
  followUp,
  formatDuration,
  type InteractionMessage,
  labelOf,
  parseDuration,
  type RespondTo,
  type StatusBody,
  successStatus,
  TICKET_PRIORITIES,
  type TicketPriority,
  tryParseDuration,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { authorizeTicket, type TicketAction, type TicketActor } from './authorize.ts';
import {
  allStaffRoles,
  CATEGORY_CHANNEL_TYPE,
  MODULE_ID,
  PANEL_ID_MAX,
  PRIORITY_LABELS,
  panelFor,
  responseFor,
  staffRolesFor,
  type TicketsConfig,
  TYPE_ID_MAX,
  typeFor,
} from './config.ts';
import {
  addParticipant,
  assign,
  type ControlInput,
  type ControlOutcome,
  claim,
  move,
  removeParticipant,
  rename,
  setLock,
  setPriority,
  transfer,
  unclaim,
} from './controls.ts';
import {
  bindStore,
  clockOf,
  describeUnbound,
  nameOf,
  type TicketsDeps,
  ticketFacts,
} from './deps.ts';
import {
  buildInfoComponents,
  describePriority,
  describeStatus,
  type TicketView,
} from './interface.ts';
import { closeTicket, deleteTicket, openTicket, refusalBody, reopenTicket } from './lifecycle.ts';
import { renderTicketText, TICKET_RESPONSE_SURFACE } from './placeholders.ts';
import { sendPanel } from './post.ts';
import type { Ticket, TicketStore } from './store.ts';
import { buildTranscript } from './transcript-delivery.ts';

type Command = CommandDefinition<TicketsConfig>;

const NOT_WIRED =
  'I can’t reach this server’s tickets right now. Nothing was changed. This is a fault on my ' +
  'side, not a setting in this server.';

const NOT_A_TICKET = 'Run this in a ticket channel, or give a ticket number with `number:`.';

const TICKET_NUMBER = 'The ticket’s number. Leave empty for the ticket you’re in.';

const NO_MEMBER = 'Choose a member for this command.';

// One key for every outcome: Discord accepts a second followup, unlike a second callback.
const ANSWER = 'answer';

type Answer = (message: InteractionMessage, slot?: string) => Promise<ActionResult>;

interface Invocation extends CommandContext<TicketsConfig> {
  answer: Answer;
}

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

function warnUnanswered(ctx: CommandContext<TicketsConfig>, result: ActionResult): void {
  if (!failed(result)) return;

  ctx.logger.warn(
    `tickets could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
  );
}

async function acknowledge(
  ctx: CommandContext<TicketsConfig>,
  deps: TicketsDeps,
): Promise<Invocation> {
  const applicationId = ctx.applicationId ?? deps.applicationId;

  // Without an application id there is no followup webhook, so the one callback must be the answer.
  if (!applicationId) {
    return {
      ...ctx,
      answer: (message, slot = ANSWER) =>
        ctx.executor.execute({
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          kind: 'interaction_reply',
          actorId: ctx.userId,
          idempotencyKey: `${ctx.idempotencyKey}:${slot}`,
          dryRun: false,
          record: false,
          payload: {
            interactionId: ctx.interaction.id,
            interactionToken: ctx.interaction.token,
            ...message,
            ephemeral: true,
          },
        }),
    };
  }

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: ctx.idempotencyKey,
  };

  warnUnanswered(ctx, await ctx.executor.execute(deferEphemeral(to)));

  return {
    ...ctx,
    answer: (message, slot = ANSWER) =>
      ctx.executor.execute(
        followUp(
          { ...to, idempotencyKey: `${ctx.idempotencyKey}:${slot}`, applicationId },
          { ...message, ephemeral: true },
        ),
      ),
  };
}

async function reply(ctx: Invocation, message: string | StatusBody, slot?: string): Promise<void> {
  const body = typeof message === 'string' ? { content: message.slice(0, 2000) } : message;

  warnUnanswered(ctx, await ctx.answer({ ...body, allowedMentions: { parse: [] } }, slot));
}

async function ready(
  ctx: Invocation,
  deps: TicketsDeps,
  what: string,
): Promise<TicketStore | null> {
  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(what, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, errorStatus(NOT_WIRED));
    return null;
  }

  return bound.store;
}

// Absent when a context was built without them, and an absent permission set must never read as
// "allowed": 0n is the fail-closed value and an empty role list matches no support role.
export function actorOf(ctx: CommandContext<TicketsConfig>): TicketActor {
  return {
    userId: ctx.userId,
    roleIds: ctx.actorRoleIds ?? [],
    permissions: ctx.actorPermissions ?? 0n,
  };
}

async function resolve(ctx: Invocation, store: TicketStore): Promise<Ticket | null> {
  const number = ctx.options.getInteger('number');

  const ticket =
    number === null
      ? await store.byChannel(ctx.guildId, ctx.channelId)
      : await store.byNumber(ctx.guildId, number);

  if (!ticket) {
    await reply(
      ctx,
      errorStatus(
        number === null
          ? NOT_A_TICKET
          : `Couldn’t find ticket #${number}. \`${labelOf(ctx, 'ticket', 'list')}\` shows the ` +
              'open ones.',
      ),
    );
    return null;
  }

  return ticket;
}

async function permitted(
  ctx: Invocation,
  action: TicketAction,
  ticket: Ticket | null,
): Promise<boolean> {
  const type = ticket ? typeFor(ctx.config, ticket.typeId) : undefined;

  const decision = authorizeTicket({
    action,
    actor: actorOf(ctx),
    ticket,
    staffRoleIds: staffRolesFor(ctx.config, type),
    ...(type ? { claimMode: type.claimMode, claimRestrictsStaff: type.claimRestrictsReplies } : {}),
    ...(type ? { reopenEnabled: type.reopenEnabled } : {}),
  });

  if (decision.allowed) return true;

  await reply(ctx, errorStatus(decision.humanReason));
  return false;
}

function controlInput(
  ctx: Invocation,
  store: TicketStore,
  deps: TicketsDeps,
  ticket: Ticket,
): ControlInput {
  return { ctx, store, deps, ticket, actorId: ctx.userId, idempotencyKey: ctx.idempotencyKey };
}

async function report(ctx: Invocation, outcome: ControlOutcome): Promise<void> {
  await reply(
    ctx,
    outcome.ok && !outcome.partial
      ? successStatus(outcome.message)
      : errorStatus(outcome.ok ? outcome.message : outcome.humanReason),
  );
}

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open, close and manage support tickets.')
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub
      .setName('panel')
      .setDescription('Post a ticket panel so members can open tickets from it.')
      .addStringOption((option) =>
        option
          .setName('panel')
          .setDescription('The panel to post.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(PANEL_ID_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Open a ticket without using a panel.')
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription('The type of ticket to open.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(TYPE_ID_MAX),
      )
      .addStringOption((option) =>
        option.setName('subject').setDescription('A one-line summary.').setMaxLength(200),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close this ticket, or another one by its number.')
      .addStringOption((option) =>
        option.setName('reason').setDescription('Why it’s being closed.').setMaxLength(512),
      )
      .addIntegerOption((option) =>
        option.setName('number').setDescription(TICKET_NUMBER).setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('reopen')
      .setDescription('Reopen a closed ticket.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription(TICKET_NUMBER).setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Delete a ticket and its channel for good.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription(TICKET_NUMBER).setMinValue(1),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Why it’s being deleted.').setMaxLength(512),
      ),
  );

  command.addSubcommand((sub) => sub.setName('claim').setDescription('Claim this ticket.'));
  command.addSubcommand((sub) =>
    sub.setName('unclaim').setDescription('Unclaim this ticket so other staff can take it.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Assign this ticket to a staff member.')
      .addUserOption((option) =>
        option
          .setName('user')
          .setDescription('The staff member. Leave empty to unassign.')
          .setRequired(false),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Give ownership of this ticket to another member.')
      .addUserOption((option) =>
        option.setName('user').setDescription('The new owner.').setRequired(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Give a member access to this ticket.')
      .addUserOption((option) =>
        option.setName('user').setDescription('The member to add.').setRequired(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a member’s access to this ticket.')
      .addUserOption((option) =>
        option.setName('user').setDescription('The member to remove.').setRequired(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename this ticket’s channel.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('The new channel name.')
          .setRequired(true)
          .setMaxLength(100),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('move')
      .setDescription('Move this ticket to another category.')
      .addChannelOption((option) =>
        option
          .setName('category')
          .setDescription('The category to move it to.')
          .setRequired(true)
          .addChannelTypes(CATEGORY_CHANNEL_TYPE),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('priority')
      .setDescription('Change this ticket’s priority.')
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription('The new priority.')
          .setRequired(true)
          .addChoices(
            ...TICKET_PRIORITIES.map((level) => ({ name: PRIORITY_LABELS[level], value: level })),
          ),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('lock').setDescription('Let only staff post in this ticket, without closing it.'),
  );
  command.addSubcommand((sub) =>
    sub.setName('unlock').setDescription('Let members post in this ticket again.'),
  );

  command.addSubcommand((sub) =>
    sub.setName('transcript').setDescription('Get a transcript of this ticket so far.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show a ticket’s details.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription(TICKET_NUMBER).setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('list').setDescription('List open tickets. Members see only their own.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('response')
      .setDescription('Post a quick response in this ticket.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('The quick response to post.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(32),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('stats')
      .setDescription('Show ticket stats for this server.')
      .addIntegerOption((option) =>
        option
          .setName('days')
          .setDescription('How many days back to look. Defaults to 30.')
          .setMinValue(1)
          .setMaxValue(365),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('blacklist')
      .setDescription('Block members from opening tickets.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Block a member from opening tickets.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to block.').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Why they’re blocked.').setMaxLength(512),
          )
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription('How long, like 7d or 12h. Leave empty to block them permanently.')
              .setMaxLength(16),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Let a member open tickets again.')
          .addUserOption((option) =>
            option.setName('user').setDescription('The member to unblock.').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List members who can’t open tickets.'),
      ),
  );

  return command;
}

export function ticketCommand(deps: TicketsDeps): Command {
  return {
    name: 'ticket',
    description: 'Open, close and manage support tickets.',

    data: builder().toJSON(),

    async handler(command) {
      const ctx = await acknowledge(command, deps);

      const store = await ready(ctx, deps, 'the ticket commands');
      if (!store) return;

      if (ctx.options.getSubcommandGroup() === 'blacklist') {
        return blacklist(ctx, store);
      }

      switch (ctx.options.getSubcommand()) {
        case 'panel':
          return postPanel(ctx);
        case 'create':
          return create(ctx, store, deps);
        case 'close':
          return close(ctx, store, deps);
        case 'reopen':
          return reopen(ctx, store);
        case 'delete':
          return remove(ctx, store, deps);
        case 'claim':
          return control(ctx, store, deps, 'claim', (input) => claim(input));
        case 'unclaim':
          return control(ctx, store, deps, 'unclaim', (input) => unclaim(input));
        case 'assign':
          return control(ctx, store, deps, 'assign', (input) =>
            assign(input, ctx.options.getUserId('user')),
          );
        case 'transfer':
          return withUser(ctx, store, deps, 'transfer', (input, userId) => transfer(input, userId));
        case 'add':
          return withUser(ctx, store, deps, 'add-participant', (input, userId) =>
            addParticipant(input, userId),
          );
        case 'remove':
          return withUser(ctx, store, deps, 'remove-participant', (input, userId) =>
            removeParticipant(input, userId),
          );
        case 'rename':
          return control(ctx, store, deps, 'rename', (input) =>
            rename(input, ctx.options.getString('name') ?? ''),
          );
        case 'move':
          return control(ctx, store, deps, 'move', (input) =>
            move(input, ctx.options.getChannelId('category') ?? ''),
          );
        case 'priority':
          return priority(ctx, store, deps);
        case 'lock':
          return control(ctx, store, deps, 'lock', (input) => setLock(input, true));
        case 'unlock':
          return control(ctx, store, deps, 'unlock', (input) => setLock(input, false));
        case 'transcript':
          return transcript(ctx, store, deps);
        case 'info':
          return info(ctx, store);
        case 'list':
          return list(ctx, store);
        case 'response':
          return quickResponse(ctx, store, deps);
        case 'stats':
          return stats(ctx, store, deps);
        default:
          await reply(
            ctx,
            errorStatus(`I don’t recognise that \`${labelOf(ctx, 'ticket')}\` subcommand.`),
          );
      }
    },
  };
}

async function postPanel(ctx: Invocation): Promise<void> {
  if (!(await permitted(ctx, 'post-panel', null))) return;

  const panelId = ctx.options.getString('panel') ?? '';
  const found = panelFor(ctx.config, panelId);

  if (!found) {
    const known = ctx.config.panels.map((entry) => `\`${entry.id}\``);

    await reply(
      ctx,
      errorStatus(
        known.length === 0
          ? 'This server has no ticket panels yet. An admin can create one in the Proton ' +
              'dashboard under Tickets.'
          : `Couldn’t find a panel called **${panelId}**. Panels here: ${known.join(', ')}.`,
      ),
    );
    return;
  }

  const posted = await sendPanel(ctx, found, {
    actorId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
  });

  if (!posted.ok) {
    await reply(
      ctx,
      errorStatus(
        `I couldn't post the **${found.name}** panel in <#${found.channelId}>: ${posted.humanReason}`,
      ),
    );
    return;
  }

  await reply(ctx, successStatus(`Posted the **${found.name}** panel in <#${found.channelId}>.`));
}

async function create(ctx: Invocation, store: TicketStore, deps: TicketsDeps): Promise<void> {
  const typeId = ctx.options.getString('type') ?? '';
  const type = typeFor(ctx.config, typeId);

  if (!type) {
    const known = ctx.config.types.map((entry) => `\`${entry.id}\``);

    await reply(
      ctx,
      errorStatus(
        known.length === 0
          ? 'This server has no ticket types yet. An admin can create one in the Proton ' +
              'dashboard under Tickets.'
          : `Couldn’t find a ticket type called **${typeId}**. Ticket types here: ` +
              `${known.join(', ')}.`,
      ),
    );
    return;
  }

  const opened = await openTicket({
    ctx,
    store,
    deps,
    type,
    panelId: '',
    openerId: ctx.userId,
    openerName: await nameOf(deps, ctx.userId),
    idempotencyKey: ctx.idempotencyKey,
    subject: ctx.options.getString('subject'),
  });

  if (opened.status === 'duplicate') {
    const earlier = await openedEarlier(ctx, store, type.id);
    if (earlier) await reply(ctx, openedStatus(earlier));
    return;
  }

  await reply(ctx, opened.status === 'refused' ? refusalBody(opened) : openedStatus(opened.ticket));
}

function openedStatus(ticket: Ticket): StatusBody {
  return successStatus(`Opened ticket #${ticket.number} in <#${ticket.channelId}>.`);
}

async function openedEarlier(
  ctx: Invocation,
  store: TicketStore,
  typeId: string,
): Promise<Ticket | null> {
  const newest = (await store.listOpen(ctx.guildId))
    .filter(
      (ticket) =>
        ticket.openerId === ctx.userId && ticket.typeId === typeId && ticket.panelId === '',
    )
    .reduce<Ticket | null>(
      (top, ticket) => (top && top.number > ticket.number ? top : ticket),
      null,
    );

  // Its own id means the first delivery is mid-open: never fall back to an older ticket.
  return newest && newest.channelId !== newest.id ? newest : null;
}

async function close(ctx: Invocation, store: TicketStore, deps: TicketsDeps): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, 'close', ticket))) return;

  const outcome = await closeTicket({
    ctx,
    store,
    deps,
    ticket,
    closedBy: ctx.userId,
    reason: ctx.options.getString('reason'),
    idempotencyKey: ctx.idempotencyKey,
  });

  if (!outcome.ok) {
    await reply(ctx, errorStatus(outcome.humanReason));
    return;
  }

  await reply(
    ctx,
    successStatus(
      outcome.replayed
        ? `Ticket #${outcome.ticket.number} was already closed, so I finished the steps that ` +
            'hadn’t run yet.'
        : `Closed ticket #${outcome.ticket.number}.`,
    ),
  );
}

async function reopen(ctx: Invocation, store: TicketStore): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, 'reopen', ticket))) return;

  const outcome = await reopenTicket(ctx, store, ticket, ctx.userId);

  await reply(
    ctx,
    outcome.ok
      ? successStatus(`Reopened ticket #${outcome.ticket.number}.`)
      : errorStatus(outcome.humanReason),
  );
}

async function remove(ctx: Invocation, store: TicketStore, deps: TicketsDeps): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, 'delete', ticket))) return;

  const outcome = await deleteTicket(
    ctx,
    store,
    deps,
    ticket,
    ctx.userId,
    ctx.options.getString('reason'),
  );

  await reply(
    ctx,
    outcome.ok
      ? successStatus(`Deleted ticket #${outcome.ticket.number} and its channel.`)
      : errorStatus(outcome.humanReason),
  );
}

async function control(
  ctx: Invocation,
  store: TicketStore,
  deps: TicketsDeps,
  action: TicketAction,
  run: (input: ControlInput) => Promise<ControlOutcome>,
): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, action, ticket))) return;

  await report(ctx, await run(controlInput(ctx, store, deps, ticket)));
}

async function withUser(
  ctx: Invocation,
  store: TicketStore,
  deps: TicketsDeps,
  action: TicketAction,
  run: (input: ControlInput, userId: string) => Promise<ControlOutcome>,
): Promise<void> {
  const userId = ctx.options.getUserId('user');

  if (userId === null) {
    await reply(ctx, errorStatus(NO_MEMBER));
    return;
  }

  await control(ctx, store, deps, action, (input) => run(input, userId));
}

async function priority(ctx: Invocation, store: TicketStore, deps: TicketsDeps): Promise<void> {
  const level = ctx.options.getString('level') ?? '';

  if (!(TICKET_PRIORITIES as readonly string[]).includes(level)) {
    await reply(
      ctx,
      errorStatus(`**${level}** isn’t a priority I know. Choose Low, Medium, High or Urgent.`),
    );
    return;
  }

  await control(ctx, store, deps, 'priority', (input) =>
    setPriority(input, level as TicketPriority),
  );
}

async function transcript(ctx: Invocation, store: TicketStore, deps: TicketsDeps): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, 'transcript', ticket))) return;

  const built = await buildTranscript({
    ctx,
    store,
    deps,
    ticket,
    type: typeFor(ctx.config, ticket.typeId),
    actorId: ctx.userId,
  });

  const result = await ctx.answer({
    ...successStatus(`Here’s the transcript of ticket #${ticket.number}.`),
    files: [
      {
        filename: built.filename,
        contentType: 'text/html',
        data: new TextEncoder().encode(built.html),
        description: `Transcript of ticket #${ticket.number}`,
      },
    ],
    allowedMentions: { parse: [] },
  });

  if (failed(result)) {
    ctx.logger.error(
      `the transcript for ticket #${ticket.number} was built but could not be sent: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function info(ctx: Invocation, store: TicketStore): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, 'info', ticket))) return;

  const type = typeFor(ctx.config, ticket.typeId);

  const view: TicketView = {
    ticket,
    type,
    typeName: type?.name ?? ticket.typeId,
    staffRoleIds: staffRolesFor(ctx.config, type),
    answers: await store.listAnswers(ticket.id),
    participants: await store.listParticipants(ticket.id),
  };

  const rating = await store.getRating(ticket.id);

  const result = await ctx.answer({
    components: buildInfoComponents(view, {
      messageCount: ticket.messageCount,
      rating: rating?.rating ?? null,
    }),
    flags: 32768 | 64,
  });

  if (failed(result)) {
    await reply(
      ctx,
      errorStatus(
        `I couldn't show ticket #${ticket.number}: ${result.failure?.humanReason ?? 'unknown reason'}`,
      ),
      'info-failed',
    );
  }
}

export function renderOpenList(tickets: readonly Ticket[], everyones = true): string {
  if (tickets.length === 0) {
    return everyones ? 'No tickets are open right now.' : 'You have no open tickets right now.';
  }

  const noun = tickets.length === 1 ? 'ticket' : 'tickets';

  return (
    `**${tickets.length} open ${noun}${everyones ? '' : ' of yours'}**\n` +
    tickets
      .map(
        (ticket) =>
          `#${ticket.number} <#${ticket.channelId}> · ${describePriority(ticket.priority)} · ` +
          `${describeStatus(ticket)}, opened by <@${ticket.openerId}> ` +
          `<t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R>` +
          (ticket.claimedById ? ` · claimed by <@${ticket.claimedById}>` : ''),
      )
      .join('\n')
      .slice(0, 1800)
  );
}

async function list(ctx: Invocation, store: TicketStore): Promise<void> {
  const open = await store.listOpen(ctx.guildId);

  // A ticket channel is private, and its name and opener are not. Showing the whole queue to
  // anyone who types the command would hand every member a directory of who asked for help.
  const staff = authorizeTicket({
    action: 'stats',
    actor: actorOf(ctx),
    ticket: null,
    staffRoleIds: allStaffRoles(ctx.config),
  }).allowed;

  const shown = staff
    ? open
    : open.filter((ticket) => ticket.ownerId === ctx.userId || ticket.openerId === ctx.userId);

  await reply(ctx, renderOpenList(shown, staff));
}

async function quickResponse(
  ctx: Invocation,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  // Answering the ticket on the team's behalf, so the member who raised it must not be able to
  // put words in the support team's mouth.
  if (!(await permitted(ctx, 'response', ticket))) return;

  const name = ctx.options.getString('name') ?? '';
  const saved = responseFor(ctx.config, name);

  if (!saved) {
    const known = ctx.config.responses.map((entry) => `\`${entry.id}\``);

    await reply(
      ctx,
      errorStatus(
        known.length === 0
          ? 'This server has no quick responses yet. An admin can create them in the Proton ' +
              'dashboard under Tickets.'
          : `Couldn’t find a quick response called **${name}**. Quick responses here: ` +
              `${known.join(', ')}.`,
      ),
    );
    return;
  }

  const facts = await ticketFacts({
    ctx,
    deps,
    store,
    surface: TICKET_RESPONSE_SURFACE,
    template: saved.content,
    ticket,
    typeName: typeFor(ctx.config, ticket.typeId)?.name ?? ticket.typeId,
    actor: { id: ctx.userId, name: ctx.actorDisplayName, nick: ctx.actorNick },
  });

  const posted = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:response`,
    dryRun: false,
    record: false,
    payload: {
      channelId: ticket.channelId,
      content: renderTicketText(
        TICKET_RESPONSE_SURFACE,
        saved.content,
        facts,
        clockOf(deps).getTime(),
      ),
      allowedMentions: { parse: [], users: [ticket.ownerId] },
    },
  });

  if (failed(posted)) {
    await reply(
      ctx,
      errorStatus(
        `I couldn't post **${saved.label}** in <#${ticket.channelId}>: ${
          posted.failure?.humanReason ?? 'unknown reason'
        }`,
      ),
    );
    return;
  }

  await store.recordEvent({
    ticketId: ticket.id,
    guildId: ctx.guildId,
    type: 'response-sent',
    actorId: ctx.userId,
    data: { responseId: saved.id },
  });

  await reply(ctx, successStatus(`Posted **${saved.label}** in <#${ticket.channelId}>.`));
}

function duration(ms: number | null): string {
  return ms === null ? 'None yet' : formatDuration(Math.round(ms));
}

function counted(total: number, one: string, many: string): string {
  return `${total} ${total === 1 ? one : many}`;
}

async function stats(ctx: Invocation, store: TicketStore, deps: TicketsDeps): Promise<void> {
  if (!(await permitted(ctx, 'stats', null))) return;

  const days = ctx.options.getInteger('days') ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const summary = await store.stats(ctx.guildId, since);

  const staff = await Promise.all(
    summary.byStaff.slice(0, 10).map(async (entry) => {
      const name = await nameOf(deps, entry.userId);
      return `${name}: ${entry.claimed} claimed, ${entry.closed} closed`;
    }),
  );

  const byType = Object.entries(summary.byType)
    .map(([typeId, total]) => `${typeFor(ctx.config, typeId)?.name ?? typeId}: ${total}`)
    .join(' · ');

  const byPriority = Object.entries(summary.byPriority)
    .map(([level, total]) => `${PRIORITY_LABELS[level as TicketPriority] ?? level}: ${total}`)
    .join(' · ');

  await reply(
    ctx,
    `**Tickets in the last ${counted(days, 'day', 'days')}**\n` +
      `Opened: ${summary.opened} · Closed: ${summary.closed} · Reopened: ${summary.reopened} · ` +
      `Still open: ${summary.open}\n` +
      `Average time to resolve: ${duration(summary.averageResolutionMs)}\n` +
      `Average first reply: ${duration(summary.averageFirstResponseMs)}\n` +
      (summary.ratings > 0
        ? `Average rating: ${summary.averageRating?.toFixed(2)} from ` +
          `${counted(summary.ratings, 'rating', 'ratings')}\n`
        : '') +
      (byType ? `\n**By type**\n${byType}\n` : '') +
      (byPriority ? `\n**By priority**\n${byPriority}\n` : '') +
      (staff.length > 0 ? `\n**By staff member**\n${staff.join('\n')}` : ''),
  );
}

async function blacklist(ctx: Invocation, store: TicketStore): Promise<void> {
  if (!(await permitted(ctx, 'blacklist', null))) return;

  const action = ctx.options.getSubcommand();

  if (action === 'list') {
    const entries = await store.listBlacklist(ctx.guildId);

    await reply(
      ctx,
      entries.length === 0
        ? 'No one is blocked from opening tickets.'
        : `**${counted(entries.length, 'member', 'members')} blocked**\n` +
            entries
              .map(
                (entry) =>
                  `<@${entry.userId}>${entry.reason ? `: ${entry.reason}` : ''}` +
                  (entry.expiresAt
                    ? ` (lifts <t:${Math.floor(entry.expiresAt.getTime() / 1000)}:R>)`
                    : ' (permanent)'),
              )
              .join('\n')
              .slice(0, 1800),
    );
    return;
  }

  const userId = ctx.options.getUserId('user');
  if (userId === null) {
    await reply(ctx, errorStatus(NO_MEMBER));
    return;
  }

  if (action === 'remove') {
    const lifted = await store.unblacklist(ctx.guildId, userId);

    await reply(
      ctx,
      lifted
        ? successStatus(`<@${userId}> can open tickets again.`)
        : errorStatus(`<@${userId}> isn’t blocked from opening tickets.`),
    );
    return;
  }

  const raw = ctx.options.getString('duration');

  if (raw !== null && tryParseDuration(raw) === null) {
    await reply(
      ctx,
      errorStatus(`**${raw}** isn’t a duration I can read. Try \`7d\`, \`12h\` or \`30m\`.`),
    );
    return;
  }

  const expiresAt = raw === null ? null : new Date(Date.now() + parseDuration(raw));

  await store.blacklist({
    guildId: ctx.guildId,
    userId,
    reason: ctx.options.getString('reason'),
    createdBy: ctx.userId,
    expiresAt,
  });

  await reply(
    ctx,
    successStatus(
      `<@${userId}> can’t open tickets` +
        (expiresAt ? ` until <t:${Math.floor(expiresAt.getTime() / 1000)}:f>` : '') +
        '. Their open tickets stay open.',
    ),
  );
}

export function ticketsCommands(deps: TicketsDeps): Command[] {
  return [ticketCommand(deps)];
}
