import {
  type CommandContext,
  type CommandDefinition,
  checkListLimit,
  type PermissionOverwriteSpec,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { MODULE_ID, PANEL_ID_MAX, panelFor, type TicketsConfig } from './config.ts';
import { bindStore, describeUnbound, type TicketsDeps } from './deps.ts';
import { closeTicket } from './lifecycle.ts';
import {
  fromGuildState,
  mergeOverwrites,
  ticketOverwrites,
  withoutParticipant,
  withParticipant,
} from './overwrites.ts';
import { buildPanelMessage } from './panel.ts';
import type { Ticket, TicketStore } from './store.ts';

type Command = CommandDefinition<TicketsConfig>;

const NOT_WIRED =
  "I can't reach this server's tickets because Proton isn't fully wired up in this deployment. " +
  'Nothing was changed. The Proton logs name the exact missing piece.';

const NOT_A_TICKET =
  'Run this inside a ticket channel — the one Proton opened when somebody pressed a ticket ' +
  'panel button. There is no ticket attached to this channel.';

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

async function inTicket(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
): Promise<Ticket | null> {
  const ticket = await store.byChannel(ctx.guildId, ctx.channelId);
  if (!ticket) {
    await reply(ctx, NOT_A_TICKET);
    return null;
  }

  return ticket;
}

// edit_channel replaces the whole overwrite array, so this has to start from what the channel
// actually has: rebuilding it from the panel would silently revoke everyone /ticket add let in
// before now.
async function overwritesFor(
  ctx: CommandContext<TicketsConfig>,
  ticket: Ticket,
  deps: TicketsDeps,
): Promise<PermissionOverwriteSpec[] | null> {
  const panel = panelFor(ctx.config, ticket.panelId);
  if (!panel) return null;

  const required = ticketOverwrites({
    guildId: ctx.guildId,
    openerId: ticket.openerId,
    panel,
    botUserId: deps.botUserId,
  });

  const live = (await deps.guildState?.get(ctx.guildId))?.channels.get(ticket.channelId);

  return mergeOverwrites(live ? fromGuildState(live.overwrites) : [], required);
}

async function setOverwrites(
  ctx: CommandContext<TicketsConfig>,
  ticket: Ticket,
  overwrites: PermissionOverwriteSpec[],
  confirmation: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_channel',
    actorId: ctx.userId,
    reason: `ticket #${ticket.number} membership changed`,
    idempotencyKey: `${ctx.idempotencyKey}:overwrites`,
    dryRun: false,
    payload: { channelId: ticket.channelId, permissionOverwrites: overwrites },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    await reply(
      ctx,
      `I couldn't change who can see this ticket: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      'refused',
    );
    return;
  }

  await reply(ctx, confirmation, 'done');
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
      .setName('close')
      .setDescription('Close the ticket you are in, or any ticket by its number.')
      .addStringOption((option) =>
        option.setName('reason').setDescription('Why it is being closed.').setMaxLength(512),
      )
      .addIntegerOption((option) =>
        option
          .setName('number')
          .setDescription(
            'Close this ticket number from anywhere — use it when its channel is gone.',
          )
          .setMinValue(1),
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
    sub.setName('list').setDescription('List the tickets that are currently open.'),
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

      switch (ctx.options.getSubcommand()) {
        case 'panel':
          return panel(ctx, deps);
        case 'close':
          return close(ctx, store);
        case 'add':
          return participant(ctx, store, deps, true);
        case 'remove':
          return participant(ctx, store, deps, false);
        case 'list':
          return list(ctx, store);
        default:
          await reply(ctx, 'That subcommand is not one I know.');
      }
    },
  };
}

async function panel(ctx: CommandContext<TicketsConfig>, deps: TicketsDeps): Promise<void> {
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

  const message = buildPanelMessage(found);
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
      content: message.content,
      components: message.components,
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
  void deps;
}

async function numbered(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  number: number,
): Promise<Ticket | null> {
  const ticket = await store.byNumber(ctx.guildId, number);
  if (!ticket) {
    await reply(
      ctx,
      `This server has no ticket #${number}. \`/ticket list\` shows the open ones with their ` +
        'numbers.',
    );
    return null;
  }

  return ticket;
}

async function close(ctx: CommandContext<TicketsConfig>, store: TicketStore): Promise<void> {
  const number = ctx.options.getInteger('number');

  const ticket = number === null ? await inTicket(ctx, store) : await numbered(ctx, store, number);
  if (!ticket) return;

  const outcome = await closeTicket({
    ctx,
    store,
    ticket,
    closedBy: ctx.userId,
    reason: ctx.options.getString('reason'),
    idempotencyKey: ctx.idempotencyKey,
  });

  if (!outcome.ok) {
    await reply(ctx, outcome.humanReason);
    return;
  }

  if (outcome.replayed) {
    await reply(
      ctx,
      `Ticket #${outcome.ticket.number} was already marked closed, so I finished the parts that ` +
        `had not run: its record, the closing message and removing <#${outcome.ticket.channelId}>. ` +
        'Anything that had already happened was left alone.',
      'done',
    );
    return;
  }

  await reply(ctx, `Closed ticket #${outcome.ticket.number}.`, 'done');
}

async function participant(
  ctx: CommandContext<TicketsConfig>,
  store: TicketStore,
  deps: TicketsDeps,
  adding: boolean,
): Promise<void> {
  const ticket = await inTicket(ctx, store);
  if (!ticket) return;

  const userId = ctx.options.getUserId('user');
  if (userId === null) {
    await reply(ctx, 'That command needs somebody to add or remove.');
    return;
  }

  if (!adding && userId === ticket.openerId) {
    await reply(
      ctx,
      'That member opened this ticket, so they cannot be removed from it. Close the ticket ' +
        'instead with `/ticket close`.',
    );
    return;
  }

  const base = await overwritesFor(ctx, ticket, deps);
  if (base === null) {
    await reply(
      ctx,
      'The panel this ticket came from is no longer in the settings, so I cannot work out who ' +
        'should be able to see it. An admin can restore the panel in the Proton dashboard.',
    );
    return;
  }

  const next = adding ? withParticipant(base, userId) : withoutParticipant(base, userId);

  await setOverwrites(
    ctx,
    ticket,
    next,
    adding ? `Added <@${userId}> to this ticket.` : `Removed <@${userId}> from this ticket.`,
  );
}

export function renderOpenList(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) return 'No tickets are open in this server right now.';

  return (
    `**${tickets.length} open ticket(s)**\n` +
    tickets
      .map(
        (ticket) =>
          `#${ticket.number} — <#${ticket.channelId}>, opened by <@${ticket.openerId}> ` +
          `<t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R>`,
      )
      .join('\n')
  );
}

async function list(ctx: CommandContext<TicketsConfig>, store: TicketStore): Promise<void> {
  await reply(ctx, renderOpenList(await store.listOpen(ctx.guildId)));
}

export function ticketsCommands(deps: TicketsDeps): Command[] {
  return [ticketCommand(deps)];
}
