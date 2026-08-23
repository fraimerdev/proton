import { durationStringSchema, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'tickets';

export const PANELS_CEILING = 40;

export const PANEL_ID_MAX = 32;

export const CHANNEL_NAME_MAX = 100;

export const TEXT_CHANNEL_TYPE = 0;

export const NUMBER_PLACEHOLDER = '{number}';
export const USER_PLACEHOLDER = '{user}';

export const DEFAULT_NAME_PATTERN = `ticket-${NUMBER_PLACEHOLDER}`;

const panelIdSchema = z
  .string()
  .min(1)
  .max(PANEL_ID_MAX)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'a panel id is letters, digits, dots, dashes and underscores, starting with a letter or digit.',
  );

export const ticketPanelSchema = z.object({
  id: panelIdSchema,

  name: z.string().min(1).max(64).default('Support'),

  channelId: snowflakeSchema,

  categoryId: snowflakeSchema.optional(),

  buttonLabel: z.string().min(1).max(80).default('Open a ticket'),

  panelText: z
    .string()
    .min(1)
    .max(2000)
    .default('Need a hand? Open a ticket and the team will be with you.'),

  openingMessage: z
    .string()
    .min(1)
    .max(2000)
    .default(`${USER_PLACEHOLDER} opened a ticket. Describe the problem and someone will help.`),

  supportRoleIds: z.array(snowflakeSchema).max(20).default([]),

  transcriptChannelId: snowflakeSchema.optional(),

  autoCloseAfter: durationStringSchema.optional(),
});

export type TicketPanel = z.infer<typeof ticketPanelSchema>;

export const ticketPanelsSchema = z
  .array(ticketPanelSchema)
  .max(PANELS_CEILING)
  .default([])
  .superRefine((panels, ctx) => {
    const seen = new Set<string>();

    for (const [index, panel] of panels.entries()) {
      if (seen.has(panel.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'two panels cannot share an id — a button would not know which one it opened.',
        });
      }
      seen.add(panel.id);
    }
  });

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
    }),

  closeConfirmation: z
    .string()
    .min(1)
    .max(2000)
    .default('This ticket is closed. The channel will be removed shortly.')
    .register(protonFields, {
      label: 'Closing message',
    }),
};

export const ticketsConfigSchema = z.object({
  ...settings,

  panels: ticketPanelsSchema,
});

// The form generator refuses arrays of objects by design (PLAN.md §9), so panels get a bespoke
// dashboard editor and are omitted here rather than crashing the settings page.
export const ticketsFormSchema = z.object(settings);

export type TicketsConfig = z.infer<typeof ticketsConfigSchema>;

export const ticketsDefaultConfig: TicketsConfig = {
  enabled: false,
  namePattern: DEFAULT_NAME_PATTERN,
  closeConfirmation: 'This ticket is closed. The channel will be removed shortly.',
  panels: [],
};

export const TICKETS_SCHEMA_VERSION = 1;

export function panelFor(config: TicketsConfig, panelId: string): TicketPanel | undefined {
  return config.panels.find((panel) => panel.id === panelId);
}

export function renderChannelName(pattern: string, number: number, opener: string): string {
  return pattern
    .split(NUMBER_PLACEHOLDER)
    .join(String(number))
    .split(USER_PLACEHOLDER)
    .join(opener)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, CHANNEL_NAME_MAX);
}

export function renderOpeningMessage(template: string, userId: string): string {
  return template.split(USER_PLACEHOLDER).join(`<@${userId}>`).slice(0, 2000);
}
