import { limitFor, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'appeals';

export const APPEALS_ACTOR = 'proton:appeals';

export const PANEL_ID_MAX = 32;

export const QUESTIONS_MAX = 5;
export const ANSWER_MAX = 1024;

export const PANELS_CEILING = limitFor('pro', 'appealPanels');

export const APPROVE_ACTIONS = ['unban', 'untimeout', 'nothing'] as const;
export type ApproveAction = (typeof APPROVE_ACTIONS)[number];

export const appealQuestionSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, hyphens and underscores only'),

  label: z.string().trim().min(1).max(120),
  placeholder: z.string().trim().max(100).optional(),

  required: z.boolean().default(true),
  maxLength: z.number().int().min(16).max(ANSWER_MAX).default(ANSWER_MAX),
});

export type AppealQuestion = z.infer<typeof appealQuestionSchema>;

export const appealPanelSchema = z.object({
  id: z.string().trim().min(1).max(PANEL_ID_MAX),
  name: z.string().trim().min(1).max(80),

  enabled: z.boolean().default(true),

  blurb: z.string().trim().max(2000).default(''),

  questions: z.array(appealQuestionSchema).min(1).max(QUESTIONS_MAX),

  reviewChannelId: snowflakeSchema.optional(),

  // How long after the punishment an appeal may still be filed, and how long somebody must wait
  // before filing another. Both measured from the moment the link was minted.
  windowDays: z.number().int().min(1).max(30).default(30),
  cooldownDays: z.number().int().min(0).max(365).default(30),

  allowResubmit: z.boolean().default(false),

  onApprove: z.enum(APPROVE_ACTIONS).default('unban'),
  liftBlocklistOnApprove: z.boolean().default(true),

  rejoinUrl: z.string().trim().max(512).optional(),

  approvedMessage: z
    .string()
    .trim()
    .max(2000)
    .default('Your appeal was accepted. You can come back to the server.'),

  deniedMessage: z
    .string()
    .trim()
    .max(2000)
    .default('Your appeal was read and turned down. The decision stands.'),
});

export type AppealPanel = z.infer<typeof appealPanelSchema>;

export const appealPanelsSchema = z
  .array(appealPanelSchema)
  .max(PANELS_CEILING)
  .default([])
  .superRefine((panels, ctx) => {
    const seen = new Set<string>();

    for (const [index, panel] of panels.entries()) {
      if (seen.has(panel.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `two forms are both called '${panel.id}'. A honeypot points at one by its id.`,
        });
      }
      seen.add(panel.id);

      const keys = new Set<string>();
      for (const [at, question] of panel.questions.entries()) {
        if (keys.has(question.key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'questions', at, 'key'],
            message:
              `two questions are both keyed '${question.key}', so one answer would ` +
              'overwrite the other.',
          });
        }
        keys.add(question.key);
      }
    }
  });

const settings = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Appeals enabled' }),

  reviewChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Default review channel',
    description: 'Where an appeal lands when its form names no channel of its own',

    channelTypes: [0, 5, 11, 12],
  }),

  reviewerRoleIds: z.array(snowflakeSchema).max(25).default([]).register(protonFields, {
    field: 'role-id',
    label: 'Default reviewers',
    description: 'Who may accept or turn down an appeal, unless the form names its own',
  }),
};

export const appealsConfigSchema = z.object({
  ...settings,
  panels: appealPanelsSchema,
});

export const appealsFormSchema = z.object(settings);

export type AppealsConfig = z.infer<typeof appealsConfigSchema>;

export const appealsDefaultConfig: AppealsConfig = appealsConfigSchema.parse({});

export const APPEALS_SCHEMA_VERSION = 1;

export function panelFor(config: AppealsConfig, panelId: string): AppealPanel | undefined {
  return config.panels.find((panel) => panel.id === panelId);
}

export function livePanels(config: AppealsConfig): AppealPanel[] {
  return config.panels.filter((panel) => panel.enabled);
}

export function reviewChannelFor(config: AppealsConfig, panel: AppealPanel): string | undefined {
  return panel.reviewChannelId ?? config.reviewChannelId;
}

// Server-wide only. A per-form reviewer list would be a setting the dashboard has no control to
// edit, and a setting nobody can see is a setting nobody can turn off.
export function reviewerRolesFor(config: AppealsConfig, _panel: AppealPanel): string[] {
  return config.reviewerRoleIds;
}
