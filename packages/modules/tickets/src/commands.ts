import {
  type CommandContext,
  type CommandDefinition,
  checkListLimit,
  formatDuration,
  parseDuration,
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
  typesOf,
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
import { bindStore, describeUnbound, nameOf, type TicketsDeps } from './deps.ts';
import {
  buildInfoComponents,
  describePriority,
  describeStatus,
  type TicketView,
} from './interface.ts';
import { closeTicket, deleteTicket, openTicket, reopenTicket } from './lifecycle.ts';
import { buildPanelMessage } from './panel.ts';
import type { Ticket, TicketStore } from './store.ts';
import { buildTranscript } from './transcript-delivery.ts';

type Command = CommandDefinition<TicketsConfig>;

const NOT_WIRED =
  "I can't reach this server's tickets because Proton isn't fully wired up in this deployment. " +
  'Nothing was changed. The Proton logs name the exact missing piece.';

const NOT_A_TICKET =
  'Run this inside a ticket channel — the one Proton opened when somebody pressed a ticket ' +
  'panel button — or name a ticket with `number:`.';

async function reply(
  ctx: CommandContext<TicketsConfig>,
  content: string,
  suffix = 'reply',
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:${suffix}`,
    dryRun: false,
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content: content.slice(0, 2000),
      ephemeral: true,
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `tickets could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function ready(
  ctx: CommandContext<TicketsConfig>,
  deps: TicketsDeps,
  what: string,
): Promise<TicketStore | null> {
  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(what, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, NOT_WIRED);
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

async function resolve(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
): Promise<Ticket | null> {
  const number = ctx.options.getInteger('number');

  const ticket =
    number === null
      ? await store.byChannel(ctx.guildId, ctx.channelId)
      : await store.byNumber(ctx.guildId, number);

  if (!ticket) {
    await reply(
      ctx,
      number === null
        ? NOT_A_TICKET
        : `This server has no ticket #${number}. \`/ticket list\` shows the open ones.`,
    );
    return null;
  }

  return ticket;
}

async function permitted(
  ctx: CommandContext<TicketsConfig>,
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

  await reply(ctx, decision.humanReason, 'refused');
  return false;
}

function controlInput(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
  ticket: Ticket,
): ControlInput {
  return { ctx, store, deps, ticket, actorId: ctx.userId, idempotencyKey: ctx.idempotencyKey };
}

async function report(ctx: CommandContext<TicketsConfig>, outcome: ControlOutcome): Promise<void> {
  await reply(
    ctx,
    outcome.ok ? outcome.message : outcome.humanReason,
    outcome.ok ? 'done' : 'refused',
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
          .setDescription('Which configured panel to post.')
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
          .setDescription('What kind of ticket to open.')
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
      .setDescription('Close the ticket you are in, or any ticket by its number.')
      .addStringOption((option) =>
        option.setName('reason').setDescription('Why it is being closed.').setMaxLength(512),
      )
      .addIntegerOption((option) =>
        option.setName('number').setDescription('Close this ticket number.').setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('reopen')
      .setDescription('Reopen a closed ticket.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription('Which ticket number.').setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Delete a ticket and its channel for good.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription('Which ticket number.').setMinValue(1),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Why it is being deleted.').setMaxLength(512),
      ),
  );

  command.addSubcommand((sub) => sub.setName('claim').setDescription('Take this ticket.'));
  command.addSubcommand((sub) => sub.setName('unclaim').setDescription('Let this ticket go.'));

  command.addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Assign this ticket to a staff member.')
      .addUserOption((option) =>
        option.setName('user').setDescription('Leave empty to unassign.').setRequired(false),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Hand ownership of this ticket to somebody else.')
      .addUserOption((option) =>
        option.setName('user').setDescription('The new owner.').setRequired(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Give somebody access to this ticket.')
      .addUserOption((option) =>
        option.setName('user').setDescription('Who to add.').setRequired(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Take somebody’s access to this ticket away.')
      .addUserOption((option) =>
        option.setName('user').setDescription('Who to remove.').setRequired(true),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename this ticket’s channel.')
      .addStringOption((option) =>
        option.setName('name').setDescription('The new name.').setRequired(true).setMaxLength(100),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('move')
      .setDescription('Move this ticket into another category.')
      .addChannelOption((option) =>
        option
          .setName('category')
          .setDescription('Where it should live.')
          .setRequired(true)
          .addChannelTypes(CATEGORY_CHANNEL_TYPE),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('priority')
      .setDescription('Change how urgent this ticket is.')
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription('How urgent it is.')
          .setRequired(true)
          .addChoices(
            ...TICKET_PRIORITIES.map((level) => ({ name: PRIORITY_LABELS[level], value: level })),
          ),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('lock').setDescription('Stop the member posting without closing the ticket.'),
  );
  command.addSubcommand((sub) =>
    sub.setName('unlock').setDescription('Let the member post again.'),
  );

  command.addSubcommand((sub) =>
    sub.setName('transcript').setDescription('Get a transcript of this ticket as it stands.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show everything Proton knows about a ticket.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription('Which ticket number.').setMinValue(1),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('list').setDescription('List the tickets that are currently open.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('response')
      .setDescription('Post one of this server’s saved replies into the ticket.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Which saved reply.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(32),
      ),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('stats')
      .setDescription('Support statistics for this server.')
      .addIntegerOption((option) =>
        option
          .setName('days')
          .setDescription('How far back to look. Defaults to 30.')
          .setMinValue(1)
          .setMaxValue(365),
      ),
  );

  command.addSubcommandGroup((group) =>
    group
      .setName('blacklist')
      .setDescription('Stop members opening tickets.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Stop a member opening tickets.')
          .addUserOption((option) =>
            option.setName('user').setDescription('Who to block.').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Why they are blocked.').setMaxLength(512),
          )
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription('How long, e.g. 7d. Leave empty for permanent.')
              .setMaxLength(16),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Let a member open tickets again.')
          .addUserOption((option) =>
            option.setName('user').setDescription('Who to unblock.').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show who cannot open tickets.')),
  );

  return command;
}

export function ticketCommand(deps: TicketsDeps): Command {
  return {
    name: 'ticket',
    description: 'Open, close and manage support tickets.',

    data: builder().toJSON(),

    async handler(ctx) {
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
          return quickResponse(ctx, store);
        case 'stats':
          return stats(ctx, store, deps);
        default:
          await reply(ctx, 'That subcommand is not one I know.');
      }
    },
  };
}

async function postPanel(ctx: CommandContext<TicketsConfig>): Promise<void> {
  if (!(await permitted(ctx, 'post-panel', null))) return;

  const panelId = ctx.options.getString('panel') ?? '';
  const found = panelFor(ctx.config, panelId);

  if (!found) {
    const known = ctx.config.panels.map((entry) => `\`${entry.id}\``);

    await reply(
      ctx,
      known.length === 0
        ? 'This server has no ticket panels configured yet. An admin can add one in the Proton ' +
            'dashboard under Tickets.'
        : `There is no panel called **${panelId}**. This server has ${known.join(', ')}.`,
    );
    return;
  }

  // Enforced here as well as at save time: an admin who added panels while on plus and then let
  // the tier lapse must not be able to keep posting the ones over the limit.
  const allowed = checkListLimit(ctx.tier ?? 'free', 'ticketPanels', ctx.config.panels.length);
  if (!allowed.ok) {
    await reply(ctx, `I did not post that panel: ${allowed.humanReason}`);
    return;
  }

  const message = buildPanelMessage(found, typesOf(ctx.config, found));
  if (!message.ok) {
    await reply(ctx, message.humanReason);
    return;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:panel`,
    dryRun: false,
    record: false,
    payload: {
      channelId: found.channelId,
      components: message.components,
      flags: 32768,
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await reply(
      ctx,
      `I couldn't post that panel: ${result.failure?.humanReason ?? 'unknown reason'}`,
      'refused',
    );
    return;
  }

  await reply(ctx, `Posted the **${found.name}** panel in <#${found.channelId}>.`, 'done');
}

async function create(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
  const typeId = ctx.options.getString('type') ?? '';
  const type = typeFor(ctx.config, typeId);

  if (!type) {
    const known = ctx.config.types.map((entry) => `\`${entry.id}\``);

    await reply(
      ctx,
      known.length === 0
        ? 'This server has no ticket types configured yet. An admin can add one in the Proton ' +
            'dashboard under Tickets.'
        : `There is no ticket type called **${typeId}**. This server has ${known.join(', ')}.`,
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

  if (opened.status === 'duplicate') return;

  await reply(
    ctx,
    opened.status === 'refused'
      ? opened.humanReason
      : `Opened ticket #${opened.ticket.number} — <#${opened.ticket.channelId}>.`,
    opened.status === 'refused' ? 'refused' : 'done',
  );
}

async function close(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
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
    await reply(ctx, outcome.humanReason);
    return;
  }

  await reply(
    ctx,
    outcome.replayed
      ? `Ticket #${outcome.ticket.number} was already marked closed, so I finished the parts that ` +
          'had not run. Anything that had already happened was left alone.'
      : `Closed ticket #${outcome.ticket.number}.`,
    'done',
  );
}

async function reopen(ctx: CommandContext<TicketsConfig>, store: TicketStore): Promise<void> {
  const ticket = await resolve(ctx, store);
  if (!ticket) return;

  if (!(await permitted(ctx, 'reopen', ticket))) return;

  const outcome = await reopenTicket(ctx, store, ticket, ctx.userId);

  await reply(
    ctx,
    outcome.ok ? `Reopened ticket #${outcome.ticket.number}.` : outcome.humanReason,
    outcome.ok ? 'done' : 'refused',
  );
}

async function remove(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
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
    outcome.ok ? `Deleted ticket #${outcome.ticket.number}.` : outcome.humanReason,
    outcome.ok ? 'done' : 'refused',
  );
}

async function control(
  ctx: CommandContext<TicketsConfig>,
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
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
  action: TicketAction,
  run: (input: ControlInput, userId: string) => Promise<ControlOutcome>,
): Promise<void> {
  const userId = ctx.options.getUserId('user');

  if (userId === null) {
    await reply(ctx, 'That command needs somebody to act on.');
    return;
  }

  await control(ctx, store, deps, action, (input) => run(input, userId));
}

async function priority(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
  const level = ctx.options.getString('level') ?? '';

  if (!(TICKET_PRIORITIES as readonly string[]).includes(level)) {
    await reply(ctx, `**${level}** is not a priority I know.`);
    return;
  }

  await control(ctx, store, deps, 'priority', (input) =>
    setPriority(input, level as TicketPriority),
  );
}

async function transcript(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
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

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:transcript`,
    dryRun: false,
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content: `Transcript of ticket #${ticket.number}.`,
      ephemeral: true,
      files: [
        {
          filename: built.filename,
          contentType: 'text/html',
          data: new TextEncoder().encode(built.html),
          description: `Transcript of ticket #${ticket.number}`,
        },
      ],
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `the transcript for ticket #${ticket.number} was built but could not be sent: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function info(ctx: CommandContext<TicketsConfig>, store: TicketStore): Promise<void> {
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

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:info`,
    dryRun: false,
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      components: buildInfoComponents(view, {
        messageCount: ticket.messageCount,
        rating: rating?.rating ?? null,
      }),
      flags: 32768 | 64,
      ephemeral: true,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await reply(ctx, `I couldn't show that ticket: ${result.failure?.humanReason ?? 'unknown'}`);
  }
}

export function renderOpenList(tickets: readonly Ticket[], everyones = true): string {
  if (tickets.length === 0) {
    return everyones
      ? 'No tickets are open in this server right now.'
      : 'You have no open tickets in this server right now.';
  }

  return (
    `**${tickets.length} open ticket(s)${everyones ? '' : ' of yours'}**\n` +
    tickets
      .map(
        (ticket) =>
          `#${ticket.number} — <#${ticket.channelId}> · ${describePriority(ticket.priority)} · ` +
          `${describeStatus(ticket)}, opened by <@${ticket.openerId}> ` +
          `<t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R>` +
          (ticket.claimedById ? ` · claimed by <@${ticket.claimedById}>` : ''),
      )
      .join('\n')
      .slice(0, 1800)
  );
}

async function list(ctx: CommandContext<TicketsConfig>, store: TicketStore): Promise<void> {
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
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
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
      known.length === 0
        ? 'This server has no saved replies yet. An admin can add them in the Proton dashboard ' +
            'under Tickets.'
        : `There is no saved reply called **${name}**. This server has ${known.join(', ')}.`,
    );
    return;
  }

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
      content: saved.content,
      allowedMentions: { parse: [], users: [ticket.ownerId] },
    },
  });

  if (posted.status === 'failed_precheck' || posted.status === 'failed_api') {
    await reply(
      ctx,
      `I couldn't post that reply: ${posted.failure?.humanReason ?? 'unknown reason'}`,
      'refused',
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

  await reply(ctx, `Posted the **${saved.label}** reply.`, 'done');
}

function duration(ms: number | null): string {
  return ms === null ? '—' : formatDuration(Math.round(ms));
}

async function stats(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
): Promise<void> {
  if (!(await permitted(ctx, 'stats', null))) return;

  const days = ctx.options.getInteger('days') ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const summary = await store.stats(ctx.guildId, since);

  const staff = await Promise.all(
    summary.byStaff.slice(0, 10).map(async (entry) => {
      const name = await nameOf(deps, entry.userId);
      return `${name} — ${entry.claimed} claimed, ${entry.closed} closed`;
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
    `**Tickets in the last ${days} day(s)**\n` +
      `Opened: ${summary.opened} · Closed: ${summary.closed} · Reopened: ${summary.reopened} · ` +
      `Still open: ${summary.open}\n` +
      `Average time to resolve: ${duration(summary.averageResolutionMs)}\n` +
      `Average first reply: ${duration(summary.averageFirstResponseMs)}\n` +
      (summary.ratings > 0
        ? `Rating: ${summary.averageRating?.toFixed(2)} from ${summary.ratings} response(s)\n`
        : '') +
      (byType ? `\n**By type**\n${byType}\n` : '') +
      (byPriority ? `\n**By priority**\n${byPriority}\n` : '') +
      (staff.length > 0 ? `\n**By staff member**\n${staff.join('\n')}` : ''),
    'stats',
  );
}

async function blacklist(ctx: CommandContext<TicketsConfig>, store: TicketStore): Promise<void> {
  if (!(await permitted(ctx, 'blacklist', null))) return;

  const action = ctx.options.getSubcommand();

  if (action === 'list') {
    const entries = await store.listBlacklist(ctx.guildId);

    await reply(
      ctx,
      entries.length === 0
        ? 'Nobody is blocked from opening tickets in this server.'
        : `**${entries.length} member${entries.length === 1 ? '' : 's'} blocked**\n` +
            entries
              .map(
                (entry) =>
                  `<@${entry.userId}>${entry.reason ? ` — ${entry.reason}` : ''}` +
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
    await reply(ctx, 'That command needs somebody to act on.');
    return;
  }

  if (action === 'remove') {
    const lifted = await store.unblacklist(ctx.guildId, userId);

    await reply(
      ctx,
      lifted
        ? `<@${userId}> can open tickets again.`
        : `<@${userId}> was not blocked from opening tickets.`,
      lifted ? 'done' : 'refused',
    );
    return;
  }

  const raw = ctx.options.getString('duration');

  if (raw !== null && tryParseDuration(raw) === null) {
    await reply(
      ctx,
      `**${raw}** is not a duration. Use something like \`7d\`, \`12h\` or \`30m\`.`,
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
    `<@${userId}> can no longer open tickets` +
      (expiresAt ? ` until <t:${Math.floor(expiresAt.getTime() / 1000)}:f>` : '') +
      '. Their existing tickets were left alone.',
    'done',
  );
}

export function ticketsCommands(deps: TicketsDeps): Command[] {
  return [ticketCommand(deps)];
}
