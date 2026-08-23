import {
  type ModuleManifest,
  Permissions,
  parseDuration,
  type ScheduledHandler,
} from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { createTicketActivityListener } from './activity.ts';
import { createTicketAutocompleteListener } from './autocomplete.ts';
import { ticketsCommands } from './commands.ts';
import {
  panelFor,
  TICKETS_SCHEMA_VERSION,
  type TicketsConfig,
  ticketsConfigSchema,
  ticketsDefaultConfig,
  ticketsFormSchema,
} from './config.ts';
import { bindStore, type TicketsDeps } from './deps.ts';
import { createTicketInteractionListener } from './interactions.ts';
import { AUTO_CLOSE_JOB, closeTicket, scheduleAutoClose } from './lifecycle.ts';

export {
  ACTIVITY_THROTTLE_MS,
  type ActivityMessage,
  createTicketActivityListener,
  handleActivity,
  readActivity,
  TICKET_ACTIVITY_EVENT_TYPES,
  watchesActivity,
} from './activity.ts';
export {
  createTicketAutocompleteListener,
  handleAutocomplete,
  TICKET_AUTOCOMPLETE_EVENT_TYPES,
} from './autocomplete.ts';
export { renderOpenList, ticketCommand, ticketsCommands } from './commands.ts';
export {
  CHANNEL_NAME_MAX,
  DEFAULT_NAME_PATTERN,
  MODULE_ID,
  NUMBER_PLACEHOLDER,
  PANEL_ID_MAX,
  PANELS_CEILING,
  panelFor,
  renderChannelName,
  renderOpeningMessage,
  TEXT_CHANNEL_TYPE,
  TICKETS_SCHEMA_VERSION,
  type TicketPanel,
  type TicketsConfig,
  ticketPanelSchema,
  ticketPanelsSchema,
  ticketsConfigSchema,
  ticketsDefaultConfig,
  ticketsFormSchema,
  USER_PLACEHOLDER,
} from './config.ts';
export {
  type ButtonBinding,
  bindButton,
  bindStore,
  describeUnbound,
  type StoreBinding,
  type TicketsDeps,
} from './deps.ts';
export {
  createTicketInteractionListener,
  handleOpenPress,
  type OpenPress,
  type PressOutcome,
  readOpenPress,
  TICKET_INTERACTION_EVENT_TYPES,
} from './interactions.ts';
export {
  AUTO_CLOSE_JOB,
  type CloseInput,
  type CloseOutcome,
  closeTicket,
  type OpenInput,
  type OpenOutcome,
  openTicket,
  scheduleAutoClose,
  transcriptLine,
} from './lifecycle.ts';
export {
  fromGuildState,
  mergeOverwrites,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  type OverwriteInput,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
  withoutParticipant,
  withParticipant,
} from './overwrites.ts';
export { buildPanelMessage, OPEN_ACTION, type PanelMessage } from './panel.ts';
export { DrizzleTicketStore } from './postgres-store.ts';
export type {
  CloseTicketInput,
  ReserveTicketInput,
  Ticket,
  TicketStatus,
  TicketStore,
} from './store.ts';
export { type NewTicketRow, type TicketRow, tickets } from './table.ts';

const autoCloseDataSchema = z.object({ ticketId: z.string().min(1) });

function autoCloseHandler(deps: TicketsDeps): ScheduledHandler<TicketsConfig> {
  return async (data, ctx) => {
    const parsed = autoCloseDataSchema.safeParse(data);
    if (!parsed.success) {
      ctx.logger.error(
        'a ticket auto-close job carried no ticket id, so nothing was closed. It is probably a ' +
          'row left behind by an older build.',
        { guildId: ctx.guildId, moduleId: 'tickets' },
      );
      return;
    }

    const bound = bindStore(deps);
    if ('unbound' in bound) return;

    const ticket = await bound.store.get(ctx.guildId, parsed.data.ticketId);
    if (ticket?.status !== 'open') return;

    const panel = panelFor(ctx.config, ticket.panelId);
    if (!panel?.autoCloseAfter) return;

    // The timer measures inactivity, so a ticket somebody spoke in since it was booked gets a new
    // deadline instead of being closed on the old one.
    const deadline = ticket.lastActivityAt.getTime() + parseDuration(panel.autoCloseAfter);

    if (deadline > Date.now()) {
      await scheduleAutoClose(ctx, panel, ticket, ticket.lastActivityAt);
      return;
    }

    await closeTicket({
      ctx,
      store: bound.store,
      ticket,
      closedBy: 'tickets',
      reason: `closed automatically after ${panel.autoCloseAfter} without a reply`,
      idempotencyKey: `tickets:auto-close:${ticket.id}`,
    });
  };
}

export function createTicketsModule(
  deps: TicketsDeps = {},
): ModuleManifest<typeof ticketsConfigSchema> {
  return {
    id: 'tickets',
    name: 'Tickets',
    category: 'utility',
    configSchema: ticketsConfigSchema,
    formSchema: ticketsFormSchema,
    defaultConfig: ticketsDefaultConfig,
    schemaVersion: TICKETS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],

    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.ManageChannels,
      Permissions.ManageRoles,
    ],
    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'send',
      'create_channel',
      'edit_channel',
      'delete_channel',
    ],

    configLimits: [{ key: 'ticketPanels', path: 'panels' }],

    commands: ticketsCommands(deps),
    listeners: [
      createTicketInteractionListener(deps),
      createTicketAutocompleteListener(deps),
      createTicketActivityListener(deps),
    ],

    schedules: [AUTO_CLOSE_JOB],
    scheduledHandlers: { [AUTO_CLOSE_JOB]: autoCloseHandler(deps) },

    dashboard: {
      icon: 'ticket',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'channels', title: 'Ticket channels', fields: ['namePattern', 'closeConfirmation'] },
      ],
    },
  };
}

export const ticketsModule: ModuleManifest<typeof ticketsConfigSchema> = createTicketsModule();

export default ticketsModule;

export type { TicketsConfig as TicketsModuleConfig };
