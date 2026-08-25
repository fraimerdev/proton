import {
  durationStringSchema,
  limitFor,
  protonFields,
  snowflakeSchema,
  TICKET_PRIORITIES,
} from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'tickets';

export const PANELS_CEILING = limitFor('pro', 'ticketPanels');

export const TYPES_CEILING = limitFor('pro', 'ticketTypes');

export const PANEL_ID_MAX = 32;

export const TYPE_ID_MAX = 32;

export const CHANNEL_NAME_MAX = 100;

export const TEXT_CHANNEL_TYPE = 0;

export const CATEGORY_CHANNEL_TYPE = 4;

export const NUMBER_PLACEHOLDER = '{number}';
export const USER_PLACEHOLDER = '{user}';
export const TYPE_PLACEHOLDER = '{type}';

export const DEFAULT_NAME_PATTERN = `ticket-${NUMBER_PLACEHOLDER}`;

// Discord takes at most five components in a modal, so a longer form could never be shown and is
// refused where the admin can still see why.
export const FORM_FIELDS_MAX = 5;

export const TICKET_STATUSES = ['open', 'closed', 'archived', 'deleted'] as const;

export type TicketStatusName = (typeof TICKET_STATUSES)[number];

export const WAITING_ON = ['staff', 'user'] as const;

export type WaitingOn = (typeof WAITING_ON)[number];

export const CLAIM_MODES = ['off', 'single', 'assignable'] as const;

export type ClaimMode = (typeof CLAIM_MODES)[number];

export const TRANSCRIPT_DESTINATIONS = ['off', 'channel', 'owner', 'both'] as const;

export type TranscriptDestination = (typeof TRANSCRIPT_DESTINATIONS)[number];

export const PANEL_STYLES = ['buttons', 'select'] as const;

export type PanelStyle = (typeof PANEL_STYLES)[number];

export const PRIORITY_LABELS: Record<(typeof TICKET_PRIORITIES)[number], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

// Priority is carried by the container accent and the word, never by an emoji: Proton ships no
// stock unicode emoji of its own. A guild that wants a glyph puts a custom one on the ticket type.
export const PRIORITY_COLOUR: Record<(typeof TICKET_PRIORITIES)[number], number> = {
  low: 0x4fcf95,
  medium: 0x3874f3,
  high: 0xf0b752,
  urgent: 0xff7a86,
};

const slugSchema = (max: number, noun: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      `a ${noun} id is letters, digits, dots, dashes and underscores, starting with a letter or digit.`,
    );

const panelIdSchema = slugSchema(PANEL_ID_MAX, 'panel');

const typeIdSchema = slugSchema(TYPE_ID_MAX, 'ticket type');

export const FORM_FIELD_STYLES = ['short', 'paragraph', 'select'] as const;

export type FormFieldStyle = (typeof FORM_FIELD_STYLES)[number];

export const ticketFormFieldSchema = z.object({
  id: slugSchema(32, 'form field'),

  label: z.string().min(1).max(45),

  style: z.enum(FORM_FIELD_STYLES).default('short'),

  placeholder: z.string().max(100).optional(),

  required: z.boolean().default(true),

  maxLength: z.number().int().min(1).max(4000).optional(),

  options: z
    .array(z.object({ label: z.string().min(1).max(100), value: z.string().min(1).max(100) }))
    .max(25)
    .default([]),
});

export type TicketFormField = z.infer<typeof ticketFormFieldSchema>;

export const ticketTypeSchema = z.object({
  id: typeIdSchema,

  name: z.string().min(1).max(64).default('Support'),

  emoji: z.string().max(64).optional(),

  description: z.string().max(100).optional(),

  categoryId: snowflakeSchema.optional(),

  archiveCategoryId: snowflakeSchema.optional(),

  staffRoleIds: z.array(snowflakeSchema).max(20).default([]),

  namePattern: z.string().min(1).max(CHANNEL_NAME_MAX).optional(),

  defaultPriority: z.enum(TICKET_PRIORITIES).default('medium'),

  askPriority: z.boolean().default(false),

  maxOpenPerUser: z.number().int().min(1).max(100).optional(),

  cooldown: durationStringSchema.optional(),

  form: z.array(ticketFormFieldSchema).max(FORM_FIELDS_MAX).default([]),

  welcomeMessage: z
    .string()
    .min(1)
    .max(2000)
    .default(`Thanks for getting in touch, ${USER_PLACEHOLDER}. Describe the problem below.`),

  mentionStaffOnOpen: z.boolean().default(true),

  claimMode: z.enum(CLAIM_MODES).default('single'),

  claimRestrictsReplies: z.boolean().default(false),

  closeRequiresConfirmation: z.boolean().default(false),

  closeRequestExpiresAfter: durationStringSchema.optional(),

  reopenEnabled: z.boolean().default(true),

  archiveOnClose: z.boolean().default(false),

  autoCloseAfter: durationStringSchema.optional(),

  inactivityWarnAfter: durationStringSchema.optional(),

  autoDeleteAfter: durationStringSchema.optional(),

  transcript: z.enum(TRANSCRIPT_DESTINATIONS).default('channel'),

  transcriptChannelId: snowflakeSchema.optional(),

  // Off unless an admin asks for it: turning it on starts retaining the text of every message sent
  // in a ticket, which is a decision about the server's members and not one Proton makes for them.
  captureMessages: z.boolean().default(false),

  askRating: z.boolean().default(false),
});

export type TicketType = z.infer<typeof ticketTypeSchema>;

function uniqueIds<T extends { id: string }>(noun: string) {
  return (entries: T[], ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();

    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `two ${noun} cannot share an id — a button would not know which one it meant.`,
        });
      }
      seen.add(entry.id);
    }
  };
}

export const ticketTypesSchema = z
  .array(ticketTypeSchema)
  .max(TYPES_CEILING)
  .default([])
  .superRefine(uniqueIds('ticket types'));

export const ticketPanelSchema = z.object({
  id: panelIdSchema,

  name: z.string().min(1).max(64).default('Support'),

  channelId: snowflakeSchema,

  typeIds: z.array(typeIdSchema).max(25).default([]),

  style: z.enum(PANEL_STYLES).default('buttons'),

  title: z.string().max(256).optional(),

  panelText: z
    .string()
    .min(1)
    .max(2000)
    .default('Need a hand? Open a ticket and the team will be with you.'),

  colour: z.number().int().min(0).max(0xffffff).optional(),

  authorName: z.string().max(256).optional(),

  footerText: z.string().max(2048).optional(),

  thumbnailUrl: z.url().max(2000).optional(),

  imageUrl: z.url().max(2000).optional(),

  selectPlaceholder: z.string().max(150).optional(),
});

export type TicketPanel = z.infer<typeof ticketPanelSchema>;

export const ticketPanelsSchema = z
  .array(ticketPanelSchema)
  .max(PANELS_CEILING)
  .default([])
  .superRefine(uniqueIds('panels'));

export const RESPONSES_CEILING = 50;

export const ticketResponseSchema = z.object({
  id: slugSchema(32, 'quick response'),

  label: z.string().min(1).max(64),

  content: z.string().min(1).max(2000),
});

export type TicketResponse = z.infer<typeof ticketResponseSchema>;

export const ticketResponsesSchema = z
  .array(ticketResponseSchema)
  .max(RESPONSES_CEILING)
  .default([])
  .superRefine(uniqueIds('quick responses'));

const settings = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
  }),

  namePattern: z
    .string()
    .min(1)
    .max(CHANNEL_NAME_MAX)
    .default(DEFAULT_NAME_PATTERN)
    .refine((value) => value.includes(NUMBER_PLACEHOLDER) || value.includes(USER_PLACEHOLDER), {
      message: `a ticket name needs ${NUMBER_PLACEHOLDER} or ${USER_PLACEHOLDER} in it, or every ticket channel would share one name.`,
    })
    .register(protonFields, {
      label: 'Ticket channel name',
      description: `Used when a ticket type does not set its own. ${NUMBER_PLACEHOLDER}, ${USER_PLACEHOLDER} and ${TYPE_PLACEHOLDER} are replaced.`,
    }),

  closeConfirmation: z
    .string()
    .min(1)
    .max(2000)
    .default('This ticket is closed. Staff can reopen it, and it will be tidied up later.')
    .register(protonFields, {
      label: 'Closing message',
    }),

  maxOpenPerUser: z.number().int().min(1).max(100).default(3).register(protonFields, {
    label: 'Open tickets per member',
    description: 'A ticket type may set a lower limit of its own. Your plan caps this too.',
  }),

  maxOpenPerGuild: z.number().int().min(1).max(500).default(200).register(protonFields, {
    label: 'Open tickets in the whole server',
    description: 'A ceiling on the queue. Discord allows 500 channels in a server in total.',
  }),

  creationCooldown: durationStringSchema
    .default('5s')
    .register(protonFields, { field: 'duration', label: 'Wait between opening tickets' }),

  logChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Ticket log channel',
    channelTypes: [TEXT_CHANNEL_TYPE],
  }),

  transcriptChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Transcript channel',
    description: 'Used when a ticket type does not name one of its own.',
    channelTypes: [TEXT_CHANNEL_TYPE],
  }),

  staffRoleIds: z.array(snowflakeSchema).max(20).default([]).register(protonFields, {
    field: 'role-id',
    label: 'Support roles',
    description: 'Reach every ticket. A ticket type can add roles that reach only its own.',
  }),

  blacklistMessage: z
    .string()
    .min(1)
    .max(500)
    .default('You cannot open tickets in this server.')
    .register(protonFields, { label: 'Message for blacklisted members' }),
};

export const ticketsConfigSchema = z.object({
  ...settings,

  types: ticketTypesSchema,

  panels: ticketPanelsSchema,

  responses: ticketResponsesSchema,
});

// The form generator refuses arrays of objects by design (PLAN.md §9), so types and panels get
// bespoke dashboard editors and are omitted here rather than crashing every service at boot.
export const ticketsFormSchema = z.object(settings);

export type TicketsConfig = z.infer<typeof ticketsConfigSchema>;

export const ticketsDefaultConfig: TicketsConfig = ticketsConfigSchema.parse({});

export const TICKETS_SCHEMA_VERSION = 2;

export function blankType(index: number): TicketType {
  return ticketTypeSchema.parse({ id: `type-${index + 1}`, name: 'Support' });
}

export function blankPanel(index: number, typeIds: readonly string[] = []): TicketPanel {
  // Parsed without the channel, then given an empty one: a new panel has no channel yet, and
  // snowflakeSchema refuses the empty string the picker starts on.
  return {
    ...ticketPanelSchema
      .omit({ channelId: true })
      .parse({ id: `panel-${index + 1}`, name: 'Support', typeIds: [...typeIds] }),
    channelId: '',
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Version 1 kept the support team, the category and the opening message on the panel itself, and
// every panel was exactly one button. Without lifting them into a ticket type here, Zod strips the
// keys it no longer knows and the next dashboard save erases every configured panel.
export function liftTicketsConfig(raw: unknown): unknown {
  const config = record(raw);
  if (!config || !Array.isArray(config.panels)) return raw;

  const legacy = config.panels
    .map(record)
    .filter((panel): panel is Record<string, unknown> => panel !== null && !('typeIds' in panel));

  if (legacy.length === 0) return raw;

  const existing = Array.isArray(config.types) ? config.types : [];
  const lifted: unknown[] = [];

  const panels = config.panels.map((entry) => {
    const panel = record(entry);
    if (!panel || 'typeIds' in panel) return entry;

    const id = typeof panel.id === 'string' ? panel.id : `panel-${lifted.length + 1}`;

    lifted.push({
      id,
      name: panel.name,
      categoryId: panel.categoryId,
      staffRoleIds: panel.supportRoleIds,
      welcomeMessage: panel.openingMessage,
      transcriptChannelId: panel.transcriptChannelId,
      autoCloseAfter: panel.autoCloseAfter,
      // Version 1 deleted the channel the moment a ticket closed, so a guild upgrading in place
      // keeps that behaviour until somebody chooses otherwise.
      autoDeleteAfter: '1s',
      reopenEnabled: false,
    });

    return {
      id,
      name: panel.name,
      channelId: panel.channelId,
      typeIds: [id],
      style: 'buttons',
      panelText: panel.panelText,
    };
  });

  const known = new Set(
    existing.map((type) => record(type)?.id).filter((id): id is string => typeof id === 'string'),
  );

  return {
    ...config,
    types: [...existing, ...lifted.filter((type) => !known.has(record(type)?.id as string))],
    panels,
  };
}

export function panelFor(config: TicketsConfig, panelId: string): TicketPanel | undefined {
  return config.panels.find((panel) => panel.id === panelId);
}

export function typeFor(config: TicketsConfig, typeId: string): TicketType | undefined {
  return config.types.find((type) => type.id === typeId);
}

export function responseFor(config: TicketsConfig, id: string): TicketResponse | undefined {
  return config.responses.find((response) => response.id === id);
}

export function typesOf(config: TicketsConfig, panel: TicketPanel): TicketType[] {
  return panel.typeIds
    .map((id) => typeFor(config, id))
    .filter((type): type is TicketType => type !== undefined);
}

export function staffRolesFor(config: TicketsConfig, type: TicketType | undefined): string[] {
  return [...new Set([...config.staffRoleIds, ...(type?.staffRoleIds ?? [])])];
}

// Every role that staffs anything. A guild-level question — may this member see the queue? — is
// not about one ticket type, so answering it from the global roles alone would refuse the people
// who actually run a category.
export function allStaffRoles(config: TicketsConfig): string[] {
  return [
    ...new Set([...config.staffRoleIds, ...config.types.flatMap((type) => type.staffRoleIds)]),
  ];
}

export function transcriptChannelFor(
  config: TicketsConfig,
  type: TicketType | undefined,
): string | undefined {
  return type?.transcriptChannelId ?? config.transcriptChannelId;
}

export function renderChannelName(
  pattern: string,
  number: number,
  opener: string,
  typeName = '',
): string {
  return sanitiseChannelName(
    pattern
      .split(NUMBER_PLACEHOLDER)
      .join(String(number))
      .split(USER_PLACEHOLDER)
      .join(opener)
      .split(TYPE_PLACEHOLDER)
      .join(typeName),
  );
}

export function sanitiseChannelName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, CHANNEL_NAME_MAX);

  // Discord refuses an empty name, and a pattern of nothing but punctuation sanitises to one.
  return cleaned === '' ? 'ticket' : cleaned;
}

export function renderOpeningMessage(template: string, userId: string): string {
  return template.split(USER_PLACEHOLDER).join(`<@${userId}>`).slice(0, 2000);
}
