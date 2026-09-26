import type {
  ActionRow,
  ApplicationStatus,
  ComponentEmoji,
  ContainerChild,
  MessageButton,
  ProtonMessage,
  SelectOption,
  SimulationAdapter,
  SimulationBuild,
  SimulationInput,
  SimulationScene,
  V2Component,
} from '@proton/core';
import {
  BUTTON_STYLE_VALUES,
  BUTTON_STYLES,
  EMPTY_MESSAGE,
  readBoolean,
  readChoice,
  readInteger,
  readText,
} from '@proton/core';
import type { PlaceholderSurface } from '@proton/core/placeholders';
import { ComponentType } from 'discord-api-types/v10';
import { buildReviewCard, reviewUrl, votingOn } from './card.ts';
import {
  type ApplicantMessageKey,
  type ApplicationsConfig,
  type FormConfig,
  type Question,
  reviewChannelFor,
} from './config.ts';
import { INFO_REQUEST_MAX, MODULE_ID, REASON_MAX, TEXT_ANSWER_MAX } from './constants.ts';
import { readCustomId } from './interface.ts';
import { buildPanel } from './panel.ts';
import {
  type ApplicantMessageFacts,
  DECISION_SURFACE,
  INFO_REQUEST_SURFACE,
  RECEIPT_SURFACE,
  renderApplicantMessage,
  WITHDRAWN_SURFACE,
} from './placeholders.ts';
import {
  type CheckedAnswer,
  checkAnswers,
  type DraftAnswers,
  type RawAnswer,
} from './questions.ts';
import { STATUS_LABELS } from './status.ts';
import type { ApplicationRecord } from './store.ts';
import { EFFECT_PROBLEM_LABELS, type EffectProblem } from './view.ts';

type Raw = Record<string, unknown>;
type Style = (typeof BUTTON_STYLES)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SILENT = { everyone: false, roles: false, users: false };
const SAMPLE_ID = 'sample';

const GONE_FORM =
  'that form isn’t in this server’s settings any more. Reload the page and try again.';
const GONE_PANEL =
  'that panel isn’t in this server’s settings any more. Reload the page and try again.';

const DM_NOTE =
  'Sent to you, since there’s no real application behind it. Nothing is filed, decided or ' +
  'granted, and no roles or XP change.';

const SHORT_SAMPLE = 'A short sample answer';
const PARAGRAPH_SAMPLE =
  'A longer sample answer. This is where an applicant explains themselves in a few sentences, ' +
  'so you can see how a full answer reads.';

const DECISIONS = ['accepted', 'rejected', 'waitlisted'] as const;
type Decision = (typeof DECISIONS)[number];

const CARD_STATUSES = [
  'submitted',
  'in_review',
  'needs_info',
  'waitlisted',
  'accepted',
  'rejected',
] as const satisfies readonly ApplicationStatus[];

const STYLE_NAMES: ReadonlyMap<number, Style> = new Map(
  BUTTON_STYLES.map((style) => [BUTTON_STYLE_VALUES[style], style]),
);

const FORM_INPUT: SimulationInput = {
  key: 'formIndex',
  label: 'Form',
  kind: 'integer',
  min: 0,
  max: 999,
  fallback: 0,
  fixed: true,
};

const PANEL_INPUT: SimulationInput = {
  key: 'panelIndex',
  label: 'Panel',
  kind: 'integer',
  min: 0,
  max: 999,
  fallback: 0,
  fixed: true,
};

const NUMBER_INPUT: SimulationInput = {
  key: 'number',
  label: 'Application number',
  kind: 'integer',
  min: 1,
  max: 999_999,
  fallback: 12,
};

function refuse(humanReason: string): SimulationBuild {
  return { ok: false, humanReason, diagnostics: [] };
}

function formAt(
  config: ApplicationsConfig,
  inputs: SimulationScene['inputs'],
): { form: FormConfig; index: number } | null {
  const index = readInteger(inputs, 'formIndex', 0);
  const form = config.forms[index];
  return form === undefined ? null : { form, index };
}

function statusPage(scene: SimulationScene): string | null {
  const base = scene.bot?.websiteUrl?.replace(/\/$/, '');
  return base ? `${base}/apply/${scene.guildId}` : null;
}

function applicantFacts(
  scene: SimulationScene,
  form: FormConfig,
  application: Partial<ApplicantMessageFacts['application']>,
  moderator: boolean,
): ApplicantMessageFacts {
  return {
    user: scene.subject.user,
    server: scene.server,
    moderator: moderator ? scene.actor.user : null,
    application: {
      number: readInteger(scene.inputs, 'number', 12),
      formName: form.name,
      statusLabel: STATUS_LABELS.submitted,
      submittedAt: scene.now - 2 * DAY_MS,
      reviewedAt: null,
      reason: null,
      request: null,
      url: statusPage(scene),
      ...application,
    },
  };
}

function rendered(
  surface: PlaceholderSurface<ApplicantMessageFacts>,
  form: FormConfig,
  index: number,
  key: ApplicantMessageKey,
  facts: ApplicantMessageFacts,
  scene: SimulationScene,
  caption: string,
): SimulationBuild {
  const result = renderApplicantMessage(surface, form.messages[key], facts, {
    now: scene.now,
    basePath: `forms.${index}.messages.${key}`,
  });
  if (!result.ok) {
    return { ok: false, humanReason: result.humanReason, diagnostics: result.diagnostics };
  }

  const message: ProtonMessage = { ...result.message, mentions: SILENT };
  return {
    ok: true,
    caption,
    diagnostics: result.diagnostics,
    output: { kind: 'message', message, attachments: [] },
  };
}

function caption(facts: ApplicantMessageFacts, what: string): string {
  const { application } = facts;
  return `application #${application.number} on ${application.formName}, ${what}`;
}

export const APPLICATIONS_RECEIPT_SIMULATION: SimulationAdapter<ApplicationsConfig> = {
  descriptor: {
    id: 'applications.receipt',
    moduleId: MODULE_ID,
    label: 'Application sent message',
    summary: 'The DM a member gets once their application is sent.',
    surfaceId: RECEIPT_SURFACE.id,
    configPath: 'forms.*.messages.receipt',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [FORM_INPUT, NUMBER_INPUT],
    note: DM_NOTE,
  },

  build(config, scene) {
    const found = formAt(config, scene.inputs);
    if (found === null) return refuse(GONE_FORM);

    const facts = applicantFacts(scene, found.form, {}, false);
    return rendered(
      RECEIPT_SURFACE,
      found.form,
      found.index,
      'receipt',
      facts,
      scene,
      caption(facts, 'just sent'),
    );
  },
};

export const APPLICATIONS_DECISION_SIMULATION: SimulationAdapter<ApplicationsConfig> = {
  descriptor: {
    id: 'applications.decision',
    moduleId: MODULE_ID,
    label: 'Decision message',
    summary: 'The DM a member gets when staff accept, reject or waitlist their application.',
    surfaceId: DECISION_SURFACE.id,
    configPath: 'forms.*.messages.accepted',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [
      FORM_INPUT,
      {
        key: 'decision',
        label: 'Decision',
        kind: 'choice',
        options: [
          { value: 'accepted', label: 'Accepted' },
          { value: 'rejected', label: 'Rejected' },
          { value: 'waitlisted', label: 'Waitlisted' },
        ],
        fallback: 'accepted',
      },
      NUMBER_INPUT,
      {
        key: 'reason',
        label: 'Reason for the applicant',
        help: 'What a reviewer wrote for the applicant when deciding.',
        kind: 'text',
        maxLength: REASON_MAX,
        fallback: 'Thanks for the thoughtful answers.',
      },
    ],
    note: DM_NOTE,
  },

  build(config, scene) {
    const found = formAt(config, scene.inputs);
    if (found === null) return refuse(GONE_FORM);

    const decision: Decision = readChoice(scene.inputs, 'decision', DECISIONS, 'accepted');
    const facts = applicantFacts(
      scene,
      found.form,
      {
        statusLabel: STATUS_LABELS[decision],
        reviewedAt: scene.now,
        reason: readText(scene.inputs, 'reason', 'Thanks for the thoughtful answers.'),
      },
      true,
    );

    return rendered(
      DECISION_SURFACE,
      found.form,
      found.index,
      decision,
      facts,
      scene,
      caption(facts, STATUS_LABELS[decision].toLowerCase()),
    );
  },
};

export const APPLICATIONS_INFO_REQUEST_SIMULATION: SimulationAdapter<ApplicationsConfig> = {
  descriptor: {
    id: 'applications.info_request',
    moduleId: MODULE_ID,
    label: 'Information request message',
    summary: 'The DM a member gets when staff need more information about their application.',
    surfaceId: INFO_REQUEST_SURFACE.id,
    configPath: 'forms.*.messages.infoRequest',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [
      FORM_INPUT,
      NUMBER_INPUT,
      {
        key: 'request',
        label: 'Question from staff',
        kind: 'text',
        maxLength: INFO_REQUEST_MAX,
        fallback: 'Could you share a link to something you’ve worked on?',
      },
    ],
    note: DM_NOTE,
  },

  build(config, scene) {
    const found = formAt(config, scene.inputs);
    if (found === null) return refuse(GONE_FORM);

    const facts = applicantFacts(
      scene,
      found.form,
      {
        statusLabel: STATUS_LABELS.needs_info,
        request: readText(
          scene.inputs,
          'request',
          'Could you share a link to something you’ve worked on?',
        ),
      },
      false,
    );

    return rendered(
      INFO_REQUEST_SURFACE,
      found.form,
      found.index,
      'infoRequest',
      facts,
      scene,
      caption(facts, 'waiting on the applicant'),
    );
  },
};

export const APPLICATIONS_WITHDRAWN_SIMULATION: SimulationAdapter<ApplicationsConfig> = {
  descriptor: {
    id: 'applications.withdrawn',
    moduleId: MODULE_ID,
    label: 'Application withdrawn message',
    summary: 'The DM a member gets after they withdraw their application.',
    surfaceId: WITHDRAWN_SURFACE.id,
    configPath: 'forms.*.messages.withdrawn',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [FORM_INPUT, NUMBER_INPUT],
    note: DM_NOTE,
  },

  build(config, scene) {
    const found = formAt(config, scene.inputs);
    if (found === null) return refuse(GONE_FORM);

    const facts = applicantFacts(
      scene,
      found.form,
      { statusLabel: STATUS_LABELS.withdrawn },
      false,
    );
    return rendered(
      WITHDRAWN_SURFACE,
      found.form,
      found.index,
      'withdrawn',
      facts,
      scene,
      caption(facts, 'withdrawn'),
    );
  },
};

function sized(base: string, question: Question): string {
  const min = question.minLength ?? 0;
  const max = question.maxLength ?? TEXT_ANSWER_MAX;
  const text = base.length < min ? base.padEnd(min, '.') : base;
  const cut = text.slice(0, max);
  return cut.endsWith(' ') ? `${cut.slice(0, -1)}.` : cut;
}

function sampleNumber(question: Question): string {
  const high = question.max;
  let value = question.min ?? (high === undefined ? 5 : Math.min(high, 5));
  if (question.integer) value = Math.ceil(value);
  return String(value);
}

function sampleRaw(question: Question): RawAnswer | undefined {
  switch (question.type) {
    case 'short':
      return sized(SHORT_SAMPLE, question);
    case 'paragraph':
      return sized(PARAGRAPH_SAMPLE, question);
    case 'number':
      return sampleNumber(question);
    case 'url':
      return `${question.schemes[0] ?? 'https'}://${question.hosts[0] ?? 'example.com'}/sample`;
    case 'single':
      return question.options[0]?.value;
    case 'multiple': {
      const wanted = Math.max(1, question.minChoices ?? 1);
      const count = Math.min(wanted, question.maxChoices ?? wanted, question.options.length);
      return count === 0 ? undefined : question.options.slice(0, count).map(({ value }) => value);
    }
    case 'confirm':
      return true;
  }
}

export function sampleAnswers(form: Pick<FormConfig, 'sections'>): CheckedAnswer[] {
  const raw: DraftAnswers = {};
  for (const section of form.sections) {
    for (const question of section.questions) {
      const value = sampleRaw(question);
      if (value !== undefined) raw[question.id] = value;
    }
  }
  return checkAnswers(form.sections, raw, { partial: true }).answers;
}

function sampleApplication(
  form: FormConfig,
  scene: SimulationScene,
  status: ApplicationStatus,
): ApplicationRecord {
  const you = scene.actor.user.id;
  const submittedAt = scene.now - 2 * HOUR_MS;
  const decided = status === 'accepted' || status === 'rejected';
  const assigned = status === 'in_review' || status === 'needs_info';

  return {
    id: SAMPLE_ID,
    guildId: scene.guildId,
    number: readInteger(scene.inputs, 'number', 12),
    formId: form.id,
    versionId: SAMPLE_ID,
    applicantId: scene.subject.user.id,
    applicantName: scene.subject.displayName,
    status,
    revision: 1,
    draft: {},
    step: 0,
    answers: sampleAnswers(form),
    source: 'discord',
    assigneeId: assigned ? you : null,
    assignedAt: assigned ? submittedAt + HOUR_MS : null,
    submittedAt,
    reviewStartedAt: assigned ? submittedAt + HOUR_MS : null,
    infoRequestedAt: status === 'needs_info' ? scene.now : null,
    infoDueAt: status === 'needs_info' ? scene.now + 14 * DAY_MS : null,
    waitlistedAt: status === 'waitlisted' ? scene.now : null,
    decidedAt: decided ? scene.now : null,
    decidedBy: decided ? you : null,
    decisionReason: decided ? 'Thanks for the thoughtful answers.' : null,
    withdrawnAt: null,
    reopenedCount: 0,
    archivedAt: null,
    expiresAt: null,
    reviewDueAt: null,
    remindedAt: null,
    contentPurgeAt: null,
    contentPurgedAt: null,
    deletedAt: null,
    dmChannelId: null,
    cardChannelId: null,
    cardMessageId: null,
    cardRevision: -1,
    interviewTicketId: null,
    interviewChannelId: null,
    createdAt: submittedAt,
    updatedAt: scene.now,
  };
}

interface Converting {
  count: number;
  url(url: string): string;
}

function keyOf(raw: Raw, converting: Converting): string {
  converting.count += 1;
  return `${readCustomId(raw.custom_id)?.action ?? 'component'}-${converting.count}`;
}

function emojiOf(raw: Raw): { emoji?: ComponentEmoji } {
  const emoji = raw.emoji;
  return typeof emoji === 'object' && emoji !== null ? { emoji: emoji as ComponentEmoji } : {};
}

function toButton(raw: Raw, converting: Converting): MessageButton | null {
  const style = STYLE_NAMES.get(Number(raw.style));
  if (style === undefined) return null;

  const label = typeof raw.label === 'string' ? raw.label : undefined;
  return {
    key: keyOf(raw, converting),
    style,
    ...(label === undefined ? {} : { label }),
    ...emojiOf(raw),
    ...(raw.disabled === true ? { disabled: true } : {}),
    ...(style === 'link' && typeof raw.url === 'string' ? { url: converting.url(raw.url) } : {}),
  };
}

function toOption(raw: Raw): SelectOption {
  const label = String(raw.label ?? '');
  return {
    key: String(raw.value ?? ''),
    label,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...emojiOf(raw),
    ...(raw.default === true ? { default: true } : {}),
    action: { kind: 'reply', content: label, ephemeral: true },
  };
}

function toRow(raw: Raw, converting: Converting): ActionRow | null {
  const children = Array.isArray(raw.components) ? (raw.components as Raw[]) : [];
  const [first] = children;

  if (first?.type === ComponentType.StringSelect) {
    const options = Array.isArray(first.options) ? (first.options as Raw[]) : [];
    return {
      kind: 'select',
      select: {
        key: keyOf(first, converting),
        ...(typeof first.placeholder === 'string' ? { placeholder: first.placeholder } : {}),
        ...(typeof first.min_values === 'number' ? { minValues: first.min_values } : {}),
        ...(typeof first.max_values === 'number' ? { maxValues: first.max_values } : {}),
        options: options.map(toOption),
      },
    };
  }

  const buttons = children
    .map((child) => toButton(child, converting))
    .filter((button): button is MessageButton => button !== null);
  return buttons.length === 0 ? null : { kind: 'buttons', buttons };
}

function toChild(raw: Raw, converting: Converting): ContainerChild | null {
  switch (raw.type) {
    case ComponentType.TextDisplay:
      return typeof raw.content === 'string' ? { kind: 'text', content: raw.content } : null;
    case ComponentType.Separator:
      return {
        kind: 'separator',
        divider: raw.divider !== false,
        spacing: raw.spacing === 2 ? 'large' : 'small',
      };
    case ComponentType.Section: {
      const text = (Array.isArray(raw.components) ? (raw.components as Raw[]) : [])
        .map((child) => child.content)
        .filter((content): content is string => typeof content === 'string');
      const accessory =
        typeof raw.accessory === 'object' && raw.accessory !== null
          ? toButton(raw.accessory as Raw, converting)
          : null;
      return accessory === null
        ? null
        : { kind: 'section', text, accessory: { kind: 'button', button: accessory } };
    }
    case ComponentType.ActionRow: {
      const row = toRow(raw, converting);
      return row === null ? null : { kind: 'row', row };
    }
    default:
      return null;
  }
}

export function toV2(
  components: readonly Raw[],
  url: (url: string) => string = (same) => same,
): V2Component[] {
  const converting: Converting = { count: 0, url };
  const converted: V2Component[] = [];

  for (const raw of components) {
    if (raw.type === ComponentType.Container) {
      const children = (Array.isArray(raw.components) ? (raw.components as Raw[]) : [])
        .map((child) => toChild(child, converting))
        .filter((child): child is ContainerChild => child !== null);
      converted.push({
        kind: 'container',
        ...(typeof raw.accent_color === 'number' ? { accentColor: raw.accent_color } : {}),
        children,
      });
      continue;
    }

    const child = toChild(raw, converting);
    if (child !== null) converted.push(child);
  }

  return converted;
}

function v2Message(v2: V2Component[]): ProtonMessage {
  return { ...EMPTY_MESSAGE, mentions: SILENT, v2 };
}

export const APPLICATIONS_REVIEW_CARD_SIMULATION: SimulationAdapter<ApplicationsConfig> = {
  descriptor: {
    id: 'applications.review_card',
    moduleId: MODULE_ID,
    label: 'Review card',
    summary: 'The card Proton posts in the review channel for staff to review an application.',
    configPath: 'forms.*.review',
    output: 'message',
    delivery: 'channel',
    subject: true,
    inputs: [
      FORM_INPUT,
      {
        key: 'status',
        label: 'Status',
        kind: 'choice',
        options: CARD_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
        fallback: 'submitted',
      },
      NUMBER_INPUT,
      {
        key: 'failedAction',
        label: 'Show a failed action',
        help: 'On: the card shows an action that didn’t go through, like a DM the applicant never got.',
        kind: 'boolean',
        fallback: false,
      },
    ],
    note:
      'Sample answers stand in for a real application. Nothing is filed, claimed, decided or ' +
      'granted, and the buttons on the copy do nothing. You appear as the reviewer.',
  },

  destination(config, inputs) {
    const found = formAt(config, inputs);
    return found === null ? null : (reviewChannelFor(config, found.form) ?? null);
  },

  build(config, scene) {
    const found = formAt(config, scene.inputs);
    if (found === null) return refuse(GONE_FORM);

    const { form } = found;
    const status = readChoice(scene.inputs, 'status', CARD_STATUSES, 'submitted');
    const application = sampleApplication(form, scene, status);
    const problems: EffectProblem[] = readBoolean(scene.inputs, 'failedAction', false)
      ? [{ effectId: SAMPLE_ID, kind: 'dm', label: EFFECT_PROBLEM_LABELS.dm }]
      : [];
    const voting = votingOn(form);
    const dashboardUrl = scene.bot?.websiteUrl?.replace(/\/$/, '') ?? null;

    const card = buildReviewCard({
      application,
      form,
      formName: form.name,
      votes: {
        accept: voting && status !== 'rejected' ? 1 : 0,
        reject: voting && status === 'rejected' ? 1 : 0,
      },
      problems,
      dashboardUrl,
      mode: form.review.cardAnswers,
      now: scene.now,
    });
    if (!card.ok) return refuse(card.humanReason);

    const sampleLink =
      dashboardUrl === null ? null : reviewUrl(dashboardUrl, scene.guildId, SAMPLE_ID);
    const queue = dashboardUrl === null ? null : reviewUrl(dashboardUrl, scene.guildId);
    const v2 = toV2(card.components, (url) => (url === sampleLink && queue !== null ? queue : url));

    return {
      ok: true,
      caption: `application #${application.number} on ${form.name}, ${STATUS_LABELS[status].toLowerCase()}`,
      diagnostics: [],
      output: { kind: 'message', message: v2Message(v2), attachments: [] },
    };
  },
};

export const APPLICATIONS_PANEL_SIMULATION: SimulationAdapter<ApplicationsConfig> = {
  descriptor: {
    id: 'applications.panel',
    moduleId: MODULE_ID,
    label: 'Application panel',
    summary: 'The message members use to pick a form and start applying.',
    configPath: 'panels',
    output: 'message',
    delivery: 'channel',
    subject: false,
    inputs: [PANEL_INPUT],
    note:
      'Posts a copy where you choose. The real panel isn’t changed, and the buttons on the copy ' +
      'do nothing, so no application is started or created.',
  },

  destination(config, inputs) {
    return config.panels[readInteger(inputs, 'panelIndex', 0)]?.channelId ?? null;
  },

  build(config, scene) {
    const panel = config.panels[readInteger(scene.inputs, 'panelIndex', 0)];
    if (panel === undefined) return refuse(GONE_PANEL);

    const built = buildPanel(config, panel);
    if (!built.ok) return refuse(built.humanReason);

    return {
      ok: true,
      caption: `the ${panel.name} panel as members see it`,
      diagnostics: [],
      output: { kind: 'message', message: v2Message(toV2(built.components)), attachments: [] },
    };
  },
};

export const applicationsSimulations: SimulationAdapter<ApplicationsConfig>[] = [
  APPLICATIONS_RECEIPT_SIMULATION,
  APPLICATIONS_DECISION_SIMULATION,
  APPLICATIONS_INFO_REQUEST_SIMULATION,
  APPLICATIONS_WITHDRAWN_SIMULATION,
  APPLICATIONS_REVIEW_CARD_SIMULATION,
  APPLICATIONS_PANEL_SIMULATION,
];
