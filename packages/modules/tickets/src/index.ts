import {
  type ModuleContext,
  type ModuleManifest,
  Permissions,
  type ScheduledHandler,
} from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createTicketActivityListener } from './activity.ts';
import { createTicketAutocompleteListener } from './autocomplete.ts';
import { ticketsCommands } from './commands.ts';
import {
  liftTicketsConfig,
  TICKETS_SCHEMA_VERSION,
  type TicketsConfig,
  ticketsConfigSchema,
  ticketsDefaultConfig,
  ticketsFormSchema,
  typeFor,
} from './config.ts';
import { bindStore, clockOf, PROTON_ACTOR, type TicketsDeps } from './deps.ts';
import { createTicketInteractionListener } from './interactions.ts';
import { archiveTicket, closeTicket, deleteTicket } from './lifecycle.ts';
import { createTicketChannelListener, createTicketPatrolListener, patrol } from './reconcile.ts';
import {
  AUTO_CLOSE_JOB,
  AUTO_DELETE_JOB,
  armTicketTimers,
  autoCloseAt,
  CLOSE_REQUEST_JOB,
  INACTIVITY_WARN_JOB,
  SWEEP_JOB,
  TICKET_JOBS,
  ticketJobDataSchema,
  warnAt,
} from './schedule.ts';
import type { Ticket, TicketStore } from './store.ts';

export {
  ACTIVITY_THROTTLE_MS,
  type ActivityMessage,
  createTicketActivityListener,
  handleActivity,
  readActivity,
  TICKET_ACTIVITY_EVENT_TYPES,
  TRANSCRIPT_RETENTION_MS,
  watchesActivity,
} from './activity.ts';
export {
  authorizeTicket,
  rolesOf,
  TICKET_ACTIONS,
  TICKET_ROLES,
  type TicketAction,
  type TicketActor,
  type TicketAuthDecision,
  type TicketAuthInput,
  type TicketRole,
} from './authorize.ts';
export {
  createTicketAutocompleteListener,
  handleAutocomplete,
  panelChoices,
  responseChoices,
  TICKET_AUTOCOMPLETE_EVENT_TYPES,
  typeChoices,
} from './autocomplete.ts';
export { actorOf, renderOpenList, ticketCommand, ticketsCommands } from './commands.ts';
export {
  blankPanel,
  blankType,
  CATEGORY_CHANNEL_TYPE,
  CHANNEL_NAME_MAX,
  CLAIM_MODES,
  type ClaimMode,
  DEFAULT_NAME_PATTERN,
  FORM_FIELD_STYLES,
  FORM_FIELDS_MAX,
  type FormFieldStyle,
  liftTicketsConfig,
  MODULE_ID,
  NUMBER_PLACEHOLDER,
  PANEL_ID_MAX,
  PANEL_STYLES,
  PANELS_CEILING,
  type PanelStyle,
  PRIORITY_COLOUR,
  PRIORITY_LABELS,
  panelFor,
  RESPONSES_CEILING,
  renderChannelName,
  renderOpeningMessage,
  responseFor,
  sanitiseChannelName,
  staffRolesFor,
  TEXT_CHANNEL_TYPE,
  TICKET_STATUSES,
  TICKETS_SCHEMA_VERSION,
  type TicketFormField,
  type TicketPanel,
  type TicketResponse,
  type TicketStatusName,
  type TicketsConfig,
  type TicketType,
  TRANSCRIPT_DESTINATIONS,
  type TranscriptDestination,
  TYPE_ID_MAX,
  TYPE_PLACEHOLDER,
  TYPES_CEILING,
  ticketFormFieldSchema,
  ticketPanelSchema,
  ticketPanelsSchema,
  ticketResponseSchema,
  ticketResponsesSchema,
  ticketsConfigSchema,
  ticketsDefaultConfig,
  ticketsFormSchema,
  ticketTypeSchema,
  ticketTypesSchema,
  transcriptChannelFor,
  typeFor,
  typesOf,
  USER_PLACEHOLDER,
  WAITING_ON,
  type WaitingOn,
} from './config.ts';
export {
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
  transfer,
  unclaim,
} from './controls.ts';
export {
  type ButtonBinding,
  bindStore,
  describeUnbound,
  nameOf,
  namesOf,
  type StoreBinding,
  type TicketsDeps,
} from './deps.ts';
export {
  ADD_SELECT_ACTION,
  createTicketInteractionListener,
  handleTicketInteraction,
  type OpenPress,
  type PressOutcome,
  REMOVE_SELECT_ACTION,
  readOpenPress,
  TICKET_INTERACTION_EVENT_TYPES,
} from './interactions.ts';
export {
  buildCloseRequestComponents,
  buildControlRows,
  buildInfoComponents,
  buildOptionRows,
  buildPanelComponents,
  buildRatingComponents,
  buildWelcomeComponents,
  describePriority,
  describeStatus,
  OPEN_ACTION,
  OPEN_TYPE_ACTION,
  SELECT_TYPE_ACTION,
  TICKET_ACCENT,
  type TicketView,
  toEmoji,
} from './interface.ts';
export {
  archiveTicket,
  type CloseInput,
  type CloseOutcome,
  closeTicket,
  type DeleteOutcome,
  deleteTicket,
  type GateOutcome,
  mayOpen,
  type OpenInput,
  type OpenOutcome,
  openTicket,
  type ReopenOutcome,
  reopenTicket,
} from './lifecycle.ts';
export {
  buildCloseReasonModal,
  buildIntakeModal,
  buildRatingCommentModal,
  buildRenameModal,
  type IntakeAnswers,
  modalFieldsFor,
  needsModal,
  readIntakeAnswers,
} from './modal.ts';
export {
  fromGuildState,
  memberOverwrite,
  mergeOverwrites,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  type OverwriteInput,
  TICKET_LOCKED_ALLOW,
  TICKET_LOCKED_DENY,
  TICKET_MEMBER_ALLOW,
  TICKET_STAFF_ALLOW,
  ticketOverwrites,
  withoutParticipant,
  withParticipant,
} from './overwrites.ts';
export { buildPanelMessage, type PanelMessage } from './panel.ts';
export { DrizzleTicketStore } from './postgres-store.ts';
export {
  armPatrol,
  createTicketChannelListener,
  createTicketPatrolListener,
  handleChannelDeleted,
  type PatrolResult,
  patrol,
  readDeletedChannel,
  TICKET_CHANNEL_EVENT_TYPES,
  TICKET_PATROL_EVENT_TYPES,
} from './reconcile.ts';
export {
  AUTO_CLOSE_JOB,
  AUTO_DELETE_JOB,
  armTicketTimers,
  autoCloseAt,
  autoDeleteAt,
  CLOSE_REQUEST_JOB,
  cancelTicketTimers,
  closeRequestAt,
  INACTIVITY_WARN_JOB,
  PER_TICKET_JOBS,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  SWEEP_JOB,
  SWEEP_KEY,
  schedulesTimers,
  TICKET_JOBS,
  type TicketJobData,
  ticketJobDataSchema,
  warnAt,
} from './schedule.ts';
export type {
  BlacklistEntry,
  BlacklistInput,
  CaptureMessageInput,
  CloseTicketInput,
  ParticipantKind,
  RecordTicketEventInput,
  ReserveTicketInput,
  Ticket,
  TicketAttachment,
  TicketEvent,
  TicketFormAnswer,
  TicketMessage,
  TicketParticipant,
  TicketRating,
  TicketStats,
  TicketStatus,
  TicketStore,
  TicketWaitingOn,
} from './store.ts';
export {
  type NewTicketRow,
  type TicketBlacklistRow,
  type TicketEventRow,
  type TicketFormAnswerRow,
  type TicketMessageRow,
  type TicketParticipantRow,
  type TicketRatingRow,
  type TicketRow,
  ticketBlacklist,
  ticketEvents,
  ticketFormAnswers,
  ticketMessages,
  ticketParticipants,
  ticketRatings,
  tickets,
} from './table.ts';
export {
  escapeHtml,
  renderTranscriptHtml,
  renderTranscriptText,
  type TranscriptInput,
  transcriptFilename,
} from './transcript.ts';
export {
  buildTranscript,
  deliverTranscript,
  type TranscriptDeliveryInput,
} from './transcript-delivery.ts';

interface JobTarget {
  ctx: ModuleContext<TicketsConfig>;
  store: TicketStore;
  ticket: Ticket;
}

function jobHandler(
  deps: TicketsDeps,
  run: (target: JobTarget) => Promise<void>,
): ScheduledHandler<TicketsConfig> {
  return async (data, ctx) => {
    const parsed = ticketJobDataSchema.safeParse(data);

    if (!parsed.success) {
      ctx.logger.error(
        'a ticket job carried no ticket id, so nothing was done. It is probably a row left ' +
          'behind by an older build.',
        { guildId: ctx.guildId, moduleId: 'tickets' },
      );
      return;
    }

    const bound = bindStore(deps);
    if ('unbound' in bound) return;

    const ticket = await bound.store.get(ctx.guildId, parsed.data.ticketId);
    if (!ticket || ticket.status === 'deleted') return;

    await run({ ctx, store: bound.store, ticket });
  };
}

function autoCloseHandler(deps: TicketsDeps): ScheduledHandler<TicketsConfig> {
  return jobHandler(deps, async ({ ctx, store, ticket }) => {
    if (ticket.status !== 'open') return;

    const type = typeFor(ctx.config, ticket.typeId);
    const due = autoCloseAt(type, ticket);
    if (due === null) return;

    // The timer measures inactivity, so a ticket somebody spoke in since it was booked gets a new
    // deadline instead of being closed on the old one.
    if (due.getTime() > clockOf(deps).getTime()) {
      await armTicketTimers(ctx, type, ticket);
      return;
    }

    await closeTicket({
      ctx,
      store,
      deps,
      ticket,
      closedBy: PROTON_ACTOR,
      reason: `closed automatically after ${type?.autoCloseAfter} without a reply`,
      idempotencyKey: `tickets:auto-close:${ticket.id}`,
    });
  });
}

function warnHandler(deps: TicketsDeps): ScheduledHandler<TicketsConfig> {
  return jobHandler(deps, async ({ ctx, ticket }) => {
    if (ticket.status !== 'open') return;

    const type = typeFor(ctx.config, ticket.typeId);
    const due = warnAt(type, ticket);
    if (due === null) return;

    if (due.getTime() > clockOf(deps).getTime()) {
      await armTicketTimers(ctx, type, ticket);
      return;
    }

    // Only when the ticket is waiting on the member: warning somebody that their unanswered
    // question has gone quiet is Proton blaming them for the team's backlog.
    if (ticket.waitingOn !== 'user') return;

    await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: 'tickets',
      kind: 'send',
      actorId: PROTON_ACTOR,
      idempotencyKey: `tickets:warn:${ticket.id}:${ticket.lastActivityAt.getTime()}`,
      dryRun: false,
      record: false,
      payload: {
        channelId: ticket.channelId,
        content:
          `<@${ticket.ownerId}> — this ticket has been quiet for a while. Reply here if you ` +
          'still need help, or it will close itself.',
        allowedMentions: { parse: [], users: [ticket.ownerId] },
      },
    });
  });
}

function autoDeleteHandler(deps: TicketsDeps): ScheduledHandler<TicketsConfig> {
  return jobHandler(deps, async ({ ctx, store, ticket }) => {
    if (ticket.status === 'open') return;

    const type = typeFor(ctx.config, ticket.typeId);

    if (type?.archiveCategoryId && ticket.status === 'closed' && !type.autoDeleteAfter) {
      await archiveTicket(ctx, store, ticket);
      return;
    }

    if (!type?.autoDeleteAfter) return;

    await deleteTicket(ctx, store, deps, ticket, PROTON_ACTOR, 'tidied up automatically', [
      'closed',
      'archived',
    ]);
  });
}

function closeRequestHandler(deps: TicketsDeps): ScheduledHandler<TicketsConfig> {
  return jobHandler(deps, async ({ ctx, store, ticket }) => {
    if (ticket.status !== 'open' || ticket.closeRequestedAt === null) return;

    await closeTicket({
      ctx,
      store,
      deps,
      ticket,
      closedBy: ticket.closeRequestedById ?? PROTON_ACTOR,
      reason: 'closed because nobody answered the request to close it',
      idempotencyKey: `tickets:close-request:${ticket.id}`,
    });
  });
}

function sweepHandler(deps: TicketsDeps): ScheduledHandler<TicketsConfig> {
  return async (_data, ctx) => {
    await patrol(ctx, deps);
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

    liftStoredConfig: liftTicketsConfig,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],

    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.ReadMessageHistory,
      Permissions.AttachFiles,
      Permissions.EmbedLinks,
      Permissions.ManageChannels,
      Permissions.ManageRoles,
    ],

    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'send',
      'edit_message',
      'create_channel',
      'edit_channel',
      'delete_channel',
      'set_channel_overwrite',
      'delete_channel_overwrite',
      'create_dm',
    ],

    emits: [
      'tickets.opened',
      'tickets.claimed',
      'tickets.closed',
      'tickets.reopened',
      'tickets.deleted',
    ],

    configLimits: [
      { key: 'ticketPanels', path: 'panels' },
      { key: 'ticketTypes', path: 'types' },
    ],

    commands: ticketsCommands(deps),
    listeners: [
      createTicketInteractionListener(deps),
      createTicketAutocompleteListener(deps),
      createTicketActivityListener(deps),
      createTicketChannelListener(deps),
      createTicketPatrolListener(deps),
    ],

    schedules: [...TICKET_JOBS],
    scheduledHandlers: {
      [AUTO_CLOSE_JOB]: autoCloseHandler(deps),
      [INACTIVITY_WARN_JOB]: warnHandler(deps),
      [AUTO_DELETE_JOB]: autoDeleteHandler(deps),
      [CLOSE_REQUEST_JOB]: closeRequestHandler(deps),
      [SWEEP_JOB]: sweepHandler(deps),
    },

    dashboard: {
      icon: 'ticket',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'staffRoleIds'] },
        {
          id: 'channels',
          title: 'Ticket channels',
          fields: ['namePattern', 'closeConfirmation'],
        },
        {
          id: 'limits',
          title: 'Limits',
          fields: ['maxOpenPerUser', 'maxOpenPerGuild', 'creationCooldown', 'blacklistMessage'],
        },
        {
          id: 'records',
          title: 'Logging and transcripts',
          fields: ['logChannelId', 'transcriptChannelId'],
        },
      ],
    },
  };
}

export const ticketsModule: ModuleManifest<typeof ticketsConfigSchema> = createTicketsModule();

export default ticketsModule;

export type { TicketsConfig as TicketsModuleConfig };
