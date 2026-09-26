import {
  componentEmojiSchema,
  liftLegacyMessage,
  limitFor,
  messageObjectSchema,
  protonFields,
  refineMessage,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';
import {
  CONFIRMATION_MAX,
  DRAFT_EXPIRY_DEFAULT_DAYS,
  FOLLOW_UP_DEADLINE_DEFAULT_DAYS,
  FORM_DESCRIPTION_MAX,
  FORM_ID_MAX,
  FORM_NAME_MAX,
  INTRO_MAX,
  OPTION_DESCRIPTION_MAX,
  OPTION_LABEL_MAX,
  OPTION_VALUE_MAX,
  OPTIONS_MAX,
  PANEL_BUTTON_FORMS_MAX,
  PANEL_FORMS_MAX,
  PANEL_ID_MAX,
  QUESTION_HELP_MAX,
  QUESTION_ID_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_PLACEHOLDER_MAX,
  QUESTIONS_PER_FORM_MAX,
  RETENTION_DEFAULT_DAYS,
  REVIEW_REMINDER_DEFAULT_HOURS,
  SECTION_DESCRIPTION_MAX,
  SECTION_ID_MAX,
  SECTION_TITLE_MAX,
  SECTIONS_MAX,
  SLUG,
  TEXT_ANSWER_MAX,
  XP_REWARD_MAX,
} from './constants.ts';

export const FORMS_CEILING = limitFor('pro', 'applicationForms');
export const PANELS_CEILING = limitFor('pro', 'applicationPanels');

export const QUESTION_TYPES = [
  'short',
  'paragraph',
  'single',
  'multiple',
  'number',
  'url',
  'confirm',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const CHOICE_TYPES: readonly QuestionType[] = ['single', 'multiple'];
export const CONDITION_SOURCE_TYPES: readonly QuestionType[] = ['single', 'multiple', 'confirm'];

export const CONFIRM_VALUE = 'yes';

export const URL_SCHEMES = ['https', 'http'] as const;
export type UrlScheme = (typeof URL_SCHEMES)[number];

export const REVIEW_CARD_MODES = ['none', 'summary', 'full'] as const;
export const PANEL_STYLES = ['buttons', 'select'] as const;

export const APPLICANT_MESSAGE_KEYS = [
  'receipt',
  'accepted',
  'rejected',
  'waitlisted',
  'infoRequest',
  'withdrawn',
] as const;
export type ApplicantMessageKey = (typeof APPLICANT_MESSAGE_KEYS)[number];

export const OUTCOME_KEYS = [
  'onSubmit',
  'onAccept',
  'onReject',
  'onWaitlist',
  'onWithdraw',
] as const;
export type OutcomeKey = (typeof OUTCOME_KEYS)[number];

const SLUG_MESSAGE =
  'Use lowercase letters, numbers, hyphens and underscores, and start with a letter or number.';

export function slug(max: number) {
  return z.string().trim().min(1).max(max).regex(SLUG, SLUG_MESSAGE);
}

export const optionSchema = z.object({
  value: slug(OPTION_VALUE_MAX),
  label: z.string().trim().min(1).max(OPTION_LABEL_MAX),
  description: z.string().trim().max(OPTION_DESCRIPTION_MAX).default(''),
});
export type QuestionOption = z.infer<typeof optionSchema>;

export const conditionSchema = z.object({
  questionId: slug(QUESTION_ID_MAX),
  values: z.array(z.string().min(1).max(OPTION_VALUE_MAX)).min(1).max(OPTIONS_MAX),
});
export type QuestionCondition = z.infer<typeof conditionSchema>;

export const questionSchema = z.object({
  id: slug(QUESTION_ID_MAX),
  type: z.enum(QUESTION_TYPES),
  label: z.string().trim().min(1).max(QUESTION_LABEL_MAX),
  help: z.string().trim().max(QUESTION_HELP_MAX).default(''),
  placeholder: z.string().trim().max(QUESTION_PLACEHOLDER_MAX).default(''),
  required: z.boolean().default(true),
  minLength: z.number().int().min(0).max(TEXT_ANSWER_MAX).optional(),
  maxLength: z.number().int().min(1).max(TEXT_ANSWER_MAX).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().default(false),
  schemes: z.array(z.enum(URL_SCHEMES)).min(1).default(['https']),
  hosts: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(20).default([]),
  options: z.array(optionSchema).max(OPTIONS_MAX).default([]),
  minChoices: z.number().int().min(0).max(OPTIONS_MAX).optional(),
  maxChoices: z.number().int().min(1).max(OPTIONS_MAX).optional(),
  showIf: conditionSchema.optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const sectionSchema = z.object({
  id: slug(SECTION_ID_MAX),
  title: z.string().trim().max(SECTION_TITLE_MAX).default(''),
  description: z.string().trim().max(SECTION_DESCRIPTION_MAX).default(''),
  questions: z.array(questionSchema).max(QUESTIONS_PER_FORM_MAX).default([]),
});
export type Section = z.infer<typeof sectionSchema>;

export type FlatQuestion = Question & { sectionId: string };

const roleIdList = (max: number) => z.array(snowflakeSchema).max(max).default([]);

export const requirementsSchema = z.object({
  roleIds: roleIdList(25),
  roleMode: z.enum(['any', 'all']).default('any'),
  blockedRoleIds: roleIdList(25),
  accountAgeDays: z.number().int().min(0).max(3650).default(0),
  memberAgeDays: z.number().int().min(0).max(3650).default(0),
  minLevel: z.number().int().min(0).max(1000).default(0),
  noActiveCase: z.boolean().default(false),
  noRecentCasesDays: z.number().int().min(0).max(3650).default(0),
});
export type Requirements = z.infer<typeof requirementsSchema>;

export const intakeSchema = z.object({
  open: z.boolean().default(false),
  opensAt: z.number().int().optional(),
  closesAt: z.number().int().optional(),
  cap: z.number().int().min(1).max(100_000).optional(),
  cooldownDays: z.number().int().min(0).max(365).default(30),
  maxActive: z.number().int().min(1).max(5).default(1),
});
export type IntakeConfig = z.infer<typeof intakeSchema>;

export const reviewSchema = z.object({
  useDefaultTeam: z.boolean().default(true),
  reviewerRoleIds: roleIdList(25),
  deciderRoleIds: roleIdList(25),
  viewerRoleIds: roleIdList(25),
  channelId: snowflakeSchema.optional(),
  cardAnswers: z.enum(REVIEW_CARD_MODES).default('summary'),
  pingRoleIds: roleIdList(10),
  requireTwoReviewers: z.boolean().default(false),
  scoring: z.boolean().default(false),
});
export type ReviewConfig = z.infer<typeof reviewSchema>;

const DM_CONTENT_ONLY =
  'a DM from Proton can carry text and embeds only. Buttons, menus and layouts do nothing there, ' +
  'so remove them.';

export const applicantMessageSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine((message, ctx) => {
    refineMessage(message, ctx);

    if (message.components.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['components'], message: DM_CONTENT_ONLY });
    }
    if (message.v2.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['v2'], message: DM_CONTENT_ONLY });
    }
  }),
);
export type ApplicantMessage = z.infer<typeof applicantMessageSchema>;

const SILENT = { everyone: false, roles: false, users: false };

function applicantDm(title: string, description: string): ApplicantMessage {
  return applicantMessageSchema.parse({
    mentions: SILENT,
    embeds: [
      {
        title,
        description,
        url: '{application.url}',
        footer: { text: 'Reference {application.id}' },
      },
    ],
  });
}

const FORM_IN_SERVER = '**{application.name}** in **{server.name}**';

export const MESSAGE_DEFAULTS: Readonly<Record<ApplicantMessageKey, ApplicantMessage>> = {
  receipt: applicantDm(
    'Application sent',
    `Your application for ${FORM_IN_SERVER} has been sent. Your reference is ` +
      '{application.id}. I’ll message you here when there’s news.',
  ),
  accepted: applicantDm(
    'Application accepted',
    `Good news: your application for ${FORM_IN_SERVER} was accepted.\n\n{application.reason}`,
  ),
  rejected: applicantDm(
    'Application not accepted',
    `Thanks for applying for ${FORM_IN_SERVER}. Your application wasn’t accepted this time.` +
      '\n\n{application.reason}',
  ),
  waitlisted: applicantDm(
    'Application waitlisted',
    `Your application for ${FORM_IN_SERVER} is on the waitlist. I’ll message you when ` +
      'there’s a decision.\n\n{application.reason}',
  ),
  infoRequest: applicantDm(
    'We need a little more information',
    `Staff reviewing your application for ${FORM_IN_SERVER} asked:\n\n{application.request}\n\n` +
      'You can answer from My applications on the server’s application panel, or on your ' +
      'application’s status page.',
  ),
  withdrawn: applicantDm(
    'Application withdrawn',
    `You withdrew your application for ${FORM_IN_SERVER}. Nothing more is needed from you.`,
  ),
};

export const CLOSED_DEFAULT = 'This form isn’t taking applications right now. Check back later.';

export const messagesSchema = z.object({
  receipt: applicantMessageSchema.default(MESSAGE_DEFAULTS.receipt),
  accepted: applicantMessageSchema.default(MESSAGE_DEFAULTS.accepted),
  rejected: applicantMessageSchema.default(MESSAGE_DEFAULTS.rejected),
  waitlisted: applicantMessageSchema.default(MESSAGE_DEFAULTS.waitlisted),
  infoRequest: applicantMessageSchema.default(MESSAGE_DEFAULTS.infoRequest),
  withdrawn: applicantMessageSchema.default(MESSAGE_DEFAULTS.withdrawn),
  closed: z.string().trim().max(1000).default(CLOSED_DEFAULT),
});
export type FormMessages = z.infer<typeof messagesSchema>;

export const outcomeSchema = z.object({
  addRoleIds: roleIdList(10),
  removeRoleIds: roleIdList(10),
});
export type Outcome = z.infer<typeof outcomeSchema>;

export const actionsSchema = z.object({
  onSubmit: outcomeSchema.prefault({}),
  onAccept: outcomeSchema
    .extend({ xp: z.number().int().min(0).max(XP_REWARD_MAX).default(0) })
    .prefault({}),
  onReject: outcomeSchema.prefault({}),
  onWaitlist: outcomeSchema.prefault({}),
  onWithdraw: outcomeSchema.prefault({}),
  removeSubmitRolesOnClose: z.boolean().default(true),
});
export type OutcomeActions = z.infer<typeof actionsSchema>;

export const CONFIRMATION_DEFAULT =
  'Thanks for applying. You’ll hear back once staff have reviewed your application.';

const formObjectSchema = z.object({
  id: slug(FORM_ID_MAX),
  name: z.string().trim().min(1).max(FORM_NAME_MAX),
  description: z.string().trim().max(FORM_DESCRIPTION_MAX).default(''),
  emoji: componentEmojiSchema.optional(),
  intro: z.string().trim().max(INTRO_MAX).default(''),
  confirmation: z.string().trim().max(CONFIRMATION_MAX).default(CONFIRMATION_DEFAULT),
  sections: z.array(sectionSchema).max(SECTIONS_MAX).default([]),
  requirements: requirementsSchema.prefault({}),
  intake: intakeSchema.prefault({}),
  review: reviewSchema.prefault({}),
  messages: messagesSchema.prefault({}),
  notify: z.object({ dm: z.boolean().default(true) }).prefault({}),
  actions: actionsSchema.prefault({}),
  interview: z.object({ ticketTypeId: z.string().trim().min(1).max(64).optional() }).prefault({}),
  archived: z.boolean().default(false),
});

type FormShape = z.infer<typeof formObjectSchema>;

export interface FormIssue {
  path: (string | number)[];
  message: string;
}

const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isHostName(host: string): boolean {
  return HOST.test(host);
}

function questionIssues(question: Question, at: (string | number)[]): FormIssue[] {
  const issues: FormIssue[] = [];
  const choice = CHOICE_TYPES.includes(question.type);

  if (choice && question.options.length < 2) {
    issues.push({
      path: [...at, 'options'],
      message: 'A choice question needs at least 2 options.',
    });
  }

  const values = new Set<string>();
  for (const [index, option] of question.options.entries()) {
    if (values.has(option.value)) {
      issues.push({
        path: [...at, 'options', index, 'value'],
        message: `Another option already uses the value '${option.value}'.`,
      });
    }
    values.add(option.value);
  }

  if (
    question.minLength !== undefined &&
    question.maxLength !== undefined &&
    question.minLength > question.maxLength
  ) {
    issues.push({
      path: [...at, 'minLength'],
      message: 'The minimum length can’t be more than the maximum length.',
    });
  }

  if (question.min !== undefined && question.max !== undefined && question.min > question.max) {
    issues.push({
      path: [...at, 'min'],
      message: 'The smallest number allowed can’t be bigger than the largest.',
    });
  }

  if (question.type === 'number' && question.integer) {
    for (const key of ['min', 'max'] as const) {
      const limit = question[key];
      if (limit !== undefined && !Number.isInteger(limit)) {
        issues.push({
          path: [...at, key],
          message: 'A whole-number question needs whole-number limits.',
        });
      }
    }
  }

  if (question.type === 'multiple') {
    const { minChoices, maxChoices } = question;
    const count = question.options.length;

    if (minChoices !== undefined && maxChoices !== undefined && minChoices > maxChoices) {
      issues.push({
        path: [...at, 'minChoices'],
        message: 'The fewest choices allowed can’t be more than the most.',
      });
    }
    if (count >= 2 && minChoices !== undefined && minChoices > count) {
      issues.push({
        path: [...at, 'minChoices'],
        message: `The fewest choices allowed can’t be more than the ${count} options.`,
      });
    }
    if (count >= 2 && maxChoices !== undefined && maxChoices > count) {
      issues.push({
        path: [...at, 'maxChoices'],
        message: `The most choices allowed can’t be more than the ${count} options.`,
      });
    }
  }

  for (const [index, host] of question.hosts.entries()) {
    if (!isHostName(host)) {
      issues.push({
        path: [...at, 'hosts', index],
        message: 'Enter a domain like github.com, without https:// or a path.',
      });
    }
  }

  return issues;
}

function conditionIssues(
  question: Question,
  at: (string | number)[],
  earlier: ReadonlyMap<string, Question>,
  everyId: ReadonlySet<string>,
): FormIssue[] {
  const condition = question.showIf;
  if (condition === undefined) return [];

  const path = [...at, 'showIf', 'questionId'];
  const source = earlier.get(condition.questionId);

  if (source === undefined) {
    const message =
      condition.questionId === question.id
        ? 'A question can’t depend on itself.'
        : everyId.has(condition.questionId)
          ? 'A question can only depend on a question that comes before it.'
          : `There’s no question with the ID '${condition.questionId}' on this form.`;
    return [{ path, message }];
  }

  if (!CONDITION_SOURCE_TYPES.includes(source.type)) {
    return [
      {
        path,
        message: `“${source.label}” isn’t a choice or confirmation question, so it can’t control other questions.`,
      },
    ];
  }

  const allowed = new Set(
    source.type === 'confirm' ? [CONFIRM_VALUE] : source.options.map((option) => option.value),
  );

  return condition.values.flatMap((value, index) =>
    allowed.has(value)
      ? []
      : [
          {
            path: [...at, 'showIf', 'values', index],
            message: `“${source.label}” has no option '${value}'.`,
          },
        ],
  );
}

function overlap(a: readonly string[], b: readonly string[]): boolean {
  const first = new Set(a);
  return b.some((id) => first.has(id));
}

export function formIssues(form: Pick<FormShape, 'sections'> & Partial<FormShape>): FormIssue[] {
  const issues: FormIssue[] = [];
  const sectionIds = new Set<string>();
  const everyId = new Set(form.sections.flatMap((section) => section.questions.map((q) => q.id)));
  const earlier = new Map<string, Question>();
  let total = 0;

  for (const [sectionIndex, section] of form.sections.entries()) {
    if (sectionIds.has(section.id)) {
      issues.push({
        path: ['sections', sectionIndex, 'id'],
        message: `Another section already uses the ID '${section.id}'.`,
      });
    }
    sectionIds.add(section.id);

    for (const [questionIndex, question] of section.questions.entries()) {
      const at = ['sections', sectionIndex, 'questions', questionIndex];
      total += 1;

      if (earlier.has(question.id)) {
        issues.push({
          path: [...at, 'id'],
          message: `Another question already uses the ID '${question.id}'.`,
        });
      }

      issues.push(
        ...questionIssues(question, at),
        ...conditionIssues(question, at, earlier, everyId),
      );

      if (!earlier.has(question.id)) earlier.set(question.id, question);
    }
  }

  if (total > QUESTIONS_PER_FORM_MAX) {
    issues.push({
      path: ['sections'],
      message: `A form can have at most ${QUESTIONS_PER_FORM_MAX} questions. This one has ${total}.`,
    });
  }

  const { requirements, intake, actions } = form;

  if (requirements && overlap(requirements.roleIds, requirements.blockedRoleIds)) {
    issues.push({
      path: ['requirements', 'blockedRoleIds'],
      message: 'A role can’t be both required and blocked. Take it out of one of the two lists.',
    });
  }

  if (
    intake?.opensAt !== undefined &&
    intake.closesAt !== undefined &&
    intake.opensAt >= intake.closesAt
  ) {
    issues.push({
      path: ['intake', 'closesAt'],
      message: 'The closing time has to be after the opening time.',
    });
  }

  if (actions) {
    for (const key of OUTCOME_KEYS) {
      if (overlap(actions[key].addRoleIds, actions[key].removeRoleIds)) {
        issues.push({
          path: ['actions', key, 'removeRoleIds'],
          message: 'A role can’t be both added and removed. Take it out of one of the two lists.',
        });
      }
    }
  }

  return issues;
}

export const formSchema = formObjectSchema.superRefine((form, ctx) => {
  for (const issue of formIssues(form)) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});
export type FormConfig = z.infer<typeof formSchema>;

export const PANEL_BODY_DEFAULT =
  'Pick a form below to see what it asks and whether you can apply. You can save your answers ' +
  'and finish later.';

export const panelSchema = z
  .object({
    id: slug(PANEL_ID_MAX),
    name: z.string().trim().min(1).max(80),
    channelId: snowflakeSchema.optional(),
    title: z.string().trim().max(256).default('Applications'),
    body: z.string().trim().max(2000).default(PANEL_BODY_DEFAULT),
    colour: z.number().int().min(0).max(0xffffff).optional(),
    formIds: z.array(slug(FORM_ID_MAX)).min(1).max(PANEL_FORMS_MAX),
    style: z.enum(PANEL_STYLES).default('buttons'),
    showMine: z.boolean().default(true),
  })
  .superRefine((panel, ctx) => {
    const seen = new Set<string>();
    for (const [index, formId] of panel.formIds.entries()) {
      if (seen.has(formId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['formIds', index],
          message: `This panel already lists the form '${formId}'.`,
        });
      }
      seen.add(formId);
    }

    if (panel.style === 'buttons' && panel.formIds.length > PANEL_BUTTON_FORMS_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['style'],
        message:
          `A panel with buttons can list up to ${PANEL_BUTTON_FORMS_MAX} forms. Switch it to a ` +
          'dropdown to list more.',
      });
    }
  });
export type PanelConfig = z.infer<typeof panelSchema>;

function uniqueIds<T extends { id: string }>(what: string) {
  return (items: readonly T[], ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Another ${what} already uses the ID '${item.id}'.`,
        });
      }
      seen.add(item.id);
    }
  };
}

function roleSetting(label: string, description: string) {
  return z
    .array(snowflakeSchema)
    .max(25)
    .default([])
    .register(protonFields, { field: 'role-id', label, description });
}

const settings = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  reviewChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Default review channel',
    description: 'Where new applications are posted when their form has no review channel.',
    channelTypes: [0, 5, 11, 12],
  }),

  reviewerRoleIds: roleSetting(
    'Reviewer roles',
    'Members with these roles can read, claim and comment on applications for forms that use the default review team.',
  ),
  deciderRoleIds: roleSetting(
    'Decider roles',
    'Members with these roles can accept or reject applications. When empty, reviewers can decide.',
  ),
  viewerRoleIds: roleSetting(
    'Viewer roles',
    'Members with these roles can read applications without reviewing them.',
  ),
  overrideRoleIds: roleSetting(
    'Reopen roles',
    'Members with these roles can reopen accepted or rejected applications.',
  ),
  exportRoleIds: roleSetting(
    'Export roles',
    'Members with these roles can download the applications they can read.',
  ),
  deleteRoleIds: roleSetting(
    'Delete roles',
    'Members with these roles can permanently delete applications and their answers.',
  ),

  draftExpiryDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(DRAFT_EXPIRY_DEFAULT_DAYS)
    .register(protonFields, { label: 'Delete unsent drafts after (days)' }),
  retentionDays: z
    .number()
    .int()
    .min(7)
    .max(365)
    .default(RETENTION_DEFAULT_DAYS)
    .register(protonFields, { label: 'Keep answers after a decision (days)' }),
  followUpDeadlineDays: z
    .number()
    .int()
    .min(0)
    .max(60)
    .default(FOLLOW_UP_DEADLINE_DEFAULT_DAYS)
    .register(protonFields, { label: 'Time to answer a question from staff (days)' }),
  reviewReminderHours: z
    .number()
    .int()
    .min(0)
    .max(336)
    .default(REVIEW_REMINDER_DEFAULT_HOURS)
    .register(protonFields, { label: 'Remind reviewers after (hours)' }),
};

export const applicationsConfigSchema = z
  .object({
    ...settings,
    forms: z
      .array(formSchema)
      .max(FORMS_CEILING)
      .default([])
      .superRefine(uniqueIds<FormConfig>('form')),
    panels: z
      .array(panelSchema)
      .max(PANELS_CEILING)
      .default([])
      .superRefine(uniqueIds<PanelConfig>('panel')),
  })
  .superRefine((config, ctx) => {
    const formIds = new Set(config.forms.map((form) => form.id));

    for (const [index, panel] of config.panels.entries()) {
      for (const [at, formId] of panel.formIds.entries()) {
        if (formIds.has(formId)) continue;
        ctx.addIssue({
          code: 'custom',
          path: ['panels', index, 'formIds', at],
          message: `There’s no form with the ID '${formId}'.`,
        });
      }
    }
  });

export const applicationsFormSchema = z.object(settings);

export type ApplicationsConfig = z.infer<typeof applicationsConfigSchema>;

export const applicationsDefaultConfig: ApplicationsConfig = applicationsConfigSchema.parse({});

export const APPLICATIONS_SCHEMA_VERSION = 1;

export function formFor(config: ApplicationsConfig, formId: string): FormConfig | undefined {
  return config.forms.find((form) => form.id === formId);
}

export function panelFor(config: ApplicationsConfig, panelId: string): PanelConfig | undefined {
  return config.panels.find((panel) => panel.id === panelId);
}

export function liveForms(config: ApplicationsConfig): FormConfig[] {
  return config.forms.filter((form) => !form.archived);
}

export interface ReviewTeam {
  reviewerRoleIds: string[];
  deciderRoleIds: string[];
  viewerRoleIds: string[];
}

export function teamFor(
  config: Pick<ApplicationsConfig, 'reviewerRoleIds' | 'deciderRoleIds' | 'viewerRoleIds'>,
  form: Pick<FormConfig, 'review'>,
): ReviewTeam {
  const source = form.review.useDefaultTeam ? config : form.review;

  return {
    reviewerRoleIds: [...source.reviewerRoleIds],
    deciderRoleIds: [...source.deciderRoleIds],
    viewerRoleIds: [...source.viewerRoleIds],
  };
}

export function reviewChannelFor(
  config: Pick<ApplicationsConfig, 'reviewChannelId'>,
  form: Pick<FormConfig, 'review'>,
): string | undefined {
  return form.review.channelId ?? config.reviewChannelId;
}

export function questionsOf(form: { sections: readonly Section[] }): FlatQuestion[] {
  return form.sections.flatMap((section) =>
    section.questions.map((question) => ({ ...question, sectionId: section.id })),
  );
}

export function grantedRoles(
  config: ApplicationsConfig,
): { path: string; roleId: string; scope: string }[] {
  return config.forms.flatMap((form, index) =>
    OUTCOME_KEYS.flatMap((key) =>
      (['addRoleIds', 'removeRoleIds'] as const).flatMap((list) =>
        form.actions[key][list].map((roleId) => ({
          path: `forms.${index}.actions.${key}.${list}`,
          roleId,
          scope: `${form.id}:${key}:${list === 'addRoleIds' ? 'add' : 'remove'}`,
        })),
      ),
    ),
  );
}
