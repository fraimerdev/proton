import {
  type ApplicationStatus,
  type ComponentEmoji,
  type InteractionMessage,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
} from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import type { Eligibility, RequirementLine } from './eligibility.ts';
import { APPLICANT_ACTION, customId } from './interface.ts';
import { clip } from './modal.ts';
import type { AnswerProblem, Step } from './questions.ts';
import { STATUS_LABELS } from './status.ts';
import { canRespond, canWithdraw, referenceOf, statusSentence } from './web.ts';

export type Component = Record<string, unknown>;

export const ACCENT = 0x2a8af7;
export const MODAL_NOTE = 'Closing a step’s window before sending it loses what you typed in it.';
export const LIST_MAX = 10;
export const PROBLEMS_SHOWN = 8;
export const TEXT_BUDGET = 3800;

const BUTTON_LABEL_MAX = 80;
const SELECT_OPTIONS_MAX = 25;
const SELECT_LABEL_MAX = 100;
const QUOTE_MAX = 2600;
const REQUIREMENTS_TEXT_MAX = 1600;
const STATUS_TEXT_MAX = 1200;
export const FRESH_START = 'new';

export function text(content: string): Component {
  return { type: ComponentType.TextDisplay, content };
}

export function separator(): Component {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

export function row(...components: Component[]): Component {
  return { type: ComponentType.ActionRow, components };
}

export function container(...components: Component[]): Component {
  return { type: ComponentType.Container, accent_color: ACCENT, components };
}

export function emojiOf(emoji: ComponentEmoji | undefined): Component | undefined {
  if (emoji === undefined || (emoji.id === undefined && emoji.name === undefined)) return undefined;
  return {
    ...(emoji.id === undefined ? {} : { id: emoji.id }),
    ...(emoji.name === undefined ? {} : { name: emoji.name }),
    ...(emoji.animated ? { animated: true } : {}),
  };
}

export function emojiText(emoji: ComponentEmoji | undefined): string {
  if (emoji?.id !== undefined) {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name ?? 'emoji'}:${emoji.id}> `;
  }
  return emoji?.name === undefined ? '' : `${emoji.name} `;
}

export interface ButtonSpec {
  label: string;
  customId: string;
  style?: ButtonStyle;
  disabled?: boolean;
  emoji?: ComponentEmoji | undefined;
}

export function button(spec: ButtonSpec): Component {
  const emoji = emojiOf(spec.emoji);
  return {
    type: ComponentType.Button,
    style: spec.style ?? ButtonStyle.Secondary,
    label: clip(spec.label, BUTTON_LABEL_MAX),
    custom_id: spec.customId,
    ...(spec.disabled ? { disabled: true } : {}),
    ...(emoji ? { emoji } : {}),
  };
}

export function linkButton(label: string, url: string): Component {
  return { type: ComponentType.Button, style: ButtonStyle.Link, label, url };
}

export function buttonRows(buttons: readonly Component[]): Component[] {
  const rows: Component[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(row(...buttons.slice(index, index + 5)));
  }
  return rows;
}

export function v2Message(components: Component[]): InteractionMessage {
  return { components, flags: MESSAGE_FLAG_IS_COMPONENTS_V2, allowedMentions: { parse: [] } };
}

export function timestamp(ms: number, style: 'R' | 'f' | 'D' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function quote(body: string): string {
  const quoted = body
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return clip(quoted, QUOTE_MAX);
}

export function stepLabel(step: Pick<Step, 'index' | 'title'>, count: number): string {
  const position = `Step ${step.index + 1} of ${count}`;
  return step.title === '' ? position : `${position} · ${step.title}`;
}

export function problemList(problems: readonly AnswerProblem[]): string {
  const shown = problems
    .slice(0, PROBLEMS_SHOWN)
    .map((problem) => `- **${problem.label}**: ${problem.message}`);
  const hidden = problems.length - shown.length;
  return hidden > 0 ? [...shown, `- and ${hidden} more.`].join('\n') : shown.join('\n');
}

export const mineButton = (): Component =>
  button({ label: 'My applications', customId: customId(APPLICANT_ACTION.mine) });

export const startButton = (formId: string, label = 'Start again', fresh = false): Component =>
  button({
    label,
    customId: fresh
      ? customId(APPLICANT_ACTION.start, formId, FRESH_START)
      : customId(APPLICANT_ACTION.start, formId),
    style: ButtonStyle.Primary,
  });

export const viewButton = (applicationId: string, label = 'View status'): Component =>
  button({ label, customId: customId(APPLICANT_ACTION.view, applicationId) });

export const reviewButton = (applicationId: string, label = 'Review answers'): Component =>
  button({ label, customId: customId(APPLICANT_ACTION.review, applicationId, '0') });

export const stepButton = (applicationId: string, index: number, label: string): Component =>
  button({ label, customId: customId(APPLICANT_ACTION.step, applicationId, String(index)) });

export const answerButton = (applicationId: string): Component =>
  button({
    label: 'Answer',
    customId: customId(APPLICANT_ACTION.respond, applicationId),
    style: ButtonStyle.Primary,
  });

export const withdrawButton = (applicationId: string): Component =>
  button({
    label: 'Withdraw',
    customId: customId(APPLICANT_ACTION.withdraw, applicationId),
    style: ButtonStyle.Danger,
  });

function markOf(line: RequirementLine): string {
  if (line.passed === true) return '✓';
  if (line.passed === false) return '✗';
  return '•';
}

export function requirementsText(eligibility: Eligibility): string {
  if (eligibility.lines.length === 0) return '**Requirements**\nAnyone in this server can apply.';

  const lines = eligibility.lines.map((line) => `${markOf(line)} ${line.text}`);
  const blocked =
    eligibility.state === 'blocked' && eligibility.issues.length > 0
      ? [
          '',
          'I can’t check every requirement right now:',
          ...[...new Set(eligibility.issues.map((issue) => issue.humanReason))].map(
            (reason) => `- ${reason}`,
          ),
        ]
      : [];

  return ['**Requirements**', ...lines, ...blocked].join('\n');
}

export interface OverviewInput {
  name: string;
  description: string;
  intro: string;
  emoji?: ComponentEmoji | undefined;
  eligibility: Eligibility | null;
  intakeLine: string;
  notices: readonly string[];
  whoCanRead: string;
  buttons: readonly Component[];
}

export function overviewScreen(input: OverviewInput): Component[] {
  const heading = `## ${emojiText(input.emoji)}${input.name}`;
  const head = input.description === '' ? heading : `${heading}\n${input.description}`;
  const requirements =
    input.eligibility === null
      ? ''
      : clip(requirementsText(input.eligibility), REQUIREMENTS_TEXT_MAX);
  const status = clip([input.intakeLine, ...input.notices].join('\n\n'), STATUS_TEXT_MAX);
  const footer = `-# ${input.whoCanRead}\n-# ${MODAL_NOTE}`;
  const room = TEXT_BUDGET - head.length - requirements.length - status.length - footer.length;
  const intro = room > 0 ? clip(input.intro, room) : '';

  const parts: Component[] = [text(head)];
  if (intro !== '') parts.push(text(intro));
  parts.push(separator());
  if (requirements !== '') parts.push(text(requirements));
  parts.push(text(status));
  parts.push(text(footer));
  if (input.buttons.length > 0) parts.push(...buttonRows(input.buttons));

  return [container(...parts)];
}

export interface StepScreenInput {
  applicationId: string;
  formName: string;
  saved: Step;
  stepCount: number;
  problems: readonly AnswerProblem[];
  next: Step | null;
}

export function stepScreen(input: StepScreenInput): Component[] {
  const { applicationId, saved } = input;
  const fixing = input.problems.length > 0;
  const state = fixing
    ? `Your answers for this step are saved, but some need fixing:\n${problemList(input.problems)}`
    : '✓ Your answers for this step are saved.';
  const upcoming = fixing
    ? 'Fix them now, or come back to them before you send your application.'
    : input.next === null
      ? 'That was the last step. Review your answers, then submit them.'
      : `Next: ${stepLabel(input.next, input.stepCount)}.`;

  const primary = fixing
    ? button({
        label: 'Fix answers',
        customId: customId(APPLICANT_ACTION.step, applicationId, String(saved.index)),
        style: ButtonStyle.Primary,
      })
    : input.next === null
      ? button({
          label: 'Review answers',
          customId: customId(APPLICANT_ACTION.review, applicationId, '0'),
          style: ButtonStyle.Primary,
        })
      : button({
          label: 'Continue',
          customId: customId(APPLICANT_ACTION.step, applicationId, String(input.next.index)),
          style: ButtonStyle.Primary,
        });

  const buttons = [
    ...(saved.index > 0 ? [stepButton(applicationId, saved.index - 1, 'Back')] : []),
    primary,
    ...(fixing ? [reviewButton(applicationId)] : []),
    button({ label: 'Save for later', customId: customId(APPLICANT_ACTION.later, applicationId) }),
    button({
      label: 'Cancel',
      customId: customId(APPLICANT_ACTION.cancel, applicationId),
      style: ButtonStyle.Danger,
    }),
  ];

  return [
    container(
      text(`## ${input.formName}\n-# ${stepLabel(saved, input.stepCount)}`),
      text(state),
      text(`${upcoming}\n-# ${MODAL_NOTE}`),
      row(...buttons),
    ),
  ];
}

export interface ReviewScreenInput {
  applicationId: string;
  revision: number;
  formName: string;
  pages: readonly string[];
  page: number;
  problems: readonly AnswerProblem[];
  steps: readonly Step[];
  notice?: string | undefined;
}

function pager(applicationId: string, page: number, count: number): Component[] {
  if (count <= 1) return [];

  return [
    row(
      button({
        label: 'Previous page',
        customId: customId(APPLICANT_ACTION.review, applicationId, String(Math.max(0, page - 1))),
        disabled: page === 0,
      }),
      button({
        label: 'Next page',
        customId: customId(APPLICANT_ACTION.review, applicationId, String(page + 1)),
        disabled: page === count - 1,
      }),
    ),
  ];
}

export function reviewBudget(problems: readonly AnswerProblem[]): number {
  const taken = problems.length === 0 ? 0 : problemList(problems).length + 60;
  return Math.max(1000, 3400 - taken);
}

export function reviewScreen(input: ReviewScreenInput): Component[] {
  const count = Math.max(1, input.pages.length);
  const page = Math.min(Math.max(0, input.page), count - 1);
  const body = input.pages[page] ?? 'You haven’t answered any questions yet.';
  const paging = count > 1 ? ` · Page ${page + 1} of ${count}` : '';

  const parts: Component[] = [text(`## Review your answers\n-# ${input.formName}${paging}`)];
  if (input.notice !== undefined) parts.push(text(input.notice));
  if (input.problems.length > 0) {
    parts.push(text(`**Fix these before you submit:**\n${problemList(input.problems)}`));
  }
  parts.push(separator(), text(body), separator());
  parts.push(text('-# Nothing is sent until you press Submit.'));
  parts.push(...pager(input.applicationId, page, count));

  if (input.steps.length > 0) {
    parts.push(
      row({
        type: ComponentType.StringSelect,
        custom_id: customId(APPLICANT_ACTION.step, input.applicationId),
        placeholder: 'Change the answers in a step',
        min_values: 1,
        max_values: 1,
        options: input.steps.slice(0, SELECT_OPTIONS_MAX).map((step) => ({
          label: clip(stepLabel(step, input.steps.length), SELECT_LABEL_MAX),
          value: String(step.index),
          description: clip(
            step.questions.map((question) => question.label).join(', '),
            SELECT_LABEL_MAX,
          ),
        })),
      }),
    );
  }

  parts.push(
    row(
      button({
        label: 'Submit',
        customId: customId(APPLICANT_ACTION.submit, input.applicationId, String(input.revision)),
        style: ButtonStyle.Success,
        disabled: input.problems.length > 0,
      }),
      button({
        label: 'Save for later',
        customId: customId(APPLICANT_ACTION.later, input.applicationId),
      }),
      button({
        label: 'Cancel',
        customId: customId(APPLICANT_ACTION.cancel, input.applicationId),
        style: ButtonStyle.Danger,
      }),
    ),
  );

  return [container(...parts)];
}

export interface AnswersScreenInput {
  applicationId: string;
  formName: string;
  number: number | null;
  pages: readonly string[] | null;
  page: number;
}

export function answersScreen(input: AnswersScreenInput): Component[] {
  const title = `${input.formName} ${referenceOf(input.number)}`.trim();
  const back = row(viewButton(input.applicationId, 'Back to status'));

  if (input.pages === null) {
    return [
      container(
        text(`## Your answers\n-# ${title}`),
        text('Your answers were deleted after the time this server keeps them.'),
        back,
      ),
    ];
  }

  const count = Math.max(1, input.pages.length);
  const page = Math.min(Math.max(0, input.page), count - 1);
  const paging = count > 1 ? ` · Page ${page + 1} of ${count}` : '';

  return [
    container(
      text(`## Your answers\n-# ${title}${paging}`),
      text(input.pages[page] ?? 'This application has no answers.'),
      ...pager(input.applicationId, page, count),
      back,
    ),
  ];
}

export interface SentScreenInput {
  applicationId: string;
  number: number;
  formName: string;
  confirmation: string;
  statusCommand: string;
  statusUrl: string | null;
  dm: boolean;
}

export function sentScreen(input: SentScreenInput): Component[] {
  const reference = referenceOf(input.number);
  const updates = [
    `Run \`${input.statusCommand}\` any time, or press My applications on the server’s application panel.`,
    ...(input.statusUrl === null ? [] : ['You can also follow it on its status page.']),
    ...(input.dm ? ['I’ll DM you when there’s news, if your DMs are open to me.'] : []),
  ].join(' ');

  const buttons: Component[] = [
    button({
      label: 'View status',
      customId: customId(APPLICANT_ACTION.view, input.applicationId),
      style: ButtonStyle.Primary,
    }),
    ...(input.statusUrl === null ? [] : [linkButton('Status page', input.statusUrl)]),
    mineButton(),
  ];

  return [
    container(
      text(
        `## Your application has been sent.\nYour reference for **${input.formName}** is **${reference}**.`,
      ),
      ...(input.confirmation === '' ? [] : [text(input.confirmation)]),
      text(`**Checking for updates**\n${updates}`),
      row(...buttons),
    ),
  ];
}

export interface MineEntry {
  id: string;
  formId: string;
  formName: string;
  status: ApplicationStatus;
  number: number | null;
  submittedAt: number | null;
  updatedAt: number;
}

function entryLine(entry: MineEntry): string {
  const title = `**${entry.formName}** ${referenceOf(entry.number)}`.trim();
  if (entry.status === 'draft') {
    return `${title}\nDraft · not sent yet · saved ${timestamp(entry.updatedAt)}`;
  }
  const sent = entry.submittedAt === null ? '' : ` · sent ${timestamp(entry.submittedAt)}`;
  return `${title}\n${STATUS_LABELS[entry.status]}${sent}`;
}

function entryButton(entry: MineEntry): Component {
  if (entry.status === 'draft') {
    return button({
      label: 'Continue',
      customId: customId(APPLICANT_ACTION.start, entry.formId),
      style: ButtonStyle.Primary,
    });
  }
  if (canRespond(entry.status)) return answerButton(entry.id);
  return viewButton(entry.id, 'View');
}

export interface MineScreenInput {
  title: string;
  empty: string;
  entries: readonly MineEntry[];
  link: string | null;
}

export function mineScreen(input: MineScreenInput): Component[] {
  const shown = input.entries.slice(0, LIST_MAX);
  const parts: Component[] = [text(`## ${input.title}`)];

  if (shown.length === 0) {
    parts.push(text(input.empty));
  } else {
    for (const entry of shown) {
      parts.push({
        type: ComponentType.Section,
        components: [text(entryLine(entry))],
        accessory: entryButton(entry),
      });
    }
    if (input.entries.length > shown.length) {
      parts.push(text(`-# Showing your ${shown.length} newest.`));
    }
  }

  if (input.link !== null) parts.push(row(linkButton('All your applications', input.link)));
  return [container(...parts)];
}

export interface StatusScreenInput {
  applicationId: string;
  formName: string;
  number: number | null;
  status: ApplicationStatus;
  submittedAt: number | null;
  decidedAt: number | null;
  decisionReason: string | null;
  request: string | null;
  infoDueAt: number | null;
  statusUrl: string | null;
  notice?: string | undefined;
}

export function statusScreen(input: StatusScreenInput): Component[] {
  const title = `${input.formName} ${referenceOf(input.number)}`.trim();
  const facts = [
    `**Status:** ${STATUS_LABELS[input.status]}`,
    statusSentence(input.status),
    ...(input.submittedAt === null ? [] : [`Sent ${timestamp(input.submittedAt, 'f')}`]),
    ...(input.decidedAt === null ? [] : [`Decided ${timestamp(input.decidedAt, 'f')}`]),
  ];
  const parts: Component[] = [text(`## ${title}`)];
  if (input.notice !== undefined) parts.push(text(input.notice));
  parts.push(text(facts.join('\n')));

  if (input.status === 'needs_info' && input.request !== null) {
    const due = input.infoDueAt === null ? '' : `\nAnswer by ${timestamp(input.infoDueAt, 'f')}.`;
    parts.push(text(`**Staff asked**\n${quote(input.request)}${due}`));
  }
  if (input.decisionReason !== null && input.decisionReason.trim() !== '') {
    parts.push(text(`**Reason**\n${quote(input.decisionReason)}`));
  }

  const buttons: Component[] = [
    ...(canRespond(input.status) ? [answerButton(input.applicationId)] : []),
    reviewButton(input.applicationId, 'Your answers'),
    ...(canWithdraw(input.status) ? [withdrawButton(input.applicationId)] : []),
    ...(input.statusUrl === null ? [] : [linkButton('Status page', input.statusUrl)]),
    mineButton(),
  ];

  parts.push(row(...buttons));
  return [container(...parts)];
}

export function withdrawConfirmScreen(input: {
  applicationId: string;
  formName: string;
  number: number | null;
}): Component[] {
  const title = `**${input.formName}** ${referenceOf(input.number)}`.trim();
  return [
    container(
      text('## Withdraw your application?'),
      text(`Staff will stop reviewing your application for ${title}. You can’t undo this.`),
      row(
        button({
          label: 'Withdraw',
          customId: customId(APPLICANT_ACTION.withdrawConfirm, input.applicationId),
          style: ButtonStyle.Danger,
        }),
        viewButton(input.applicationId, 'Keep it'),
      ),
    ),
  ];
}

export function noticeScreen(
  heading: string,
  body: string,
  buttons: readonly Component[],
): Component[] {
  return [
    container(
      text(`## ${heading}`),
      text(body),
      ...(buttons.length > 0 ? buttonRows(buttons) : []),
    ),
  ];
}

export function cancelConfirmScreen(input: {
  applicationId: string;
  formName: string;
}): Component[] {
  return noticeScreen(
    'Delete your saved answers?',
    `Your draft for **${input.formName}** will be deleted. You can’t undo this.`,
    [
      button({
        label: 'Delete answers',
        customId: customId(APPLICANT_ACTION.cancelConfirm, input.applicationId),
        style: ButtonStyle.Danger,
      }),
      button({
        label: 'Keep them',
        customId: customId(APPLICANT_ACTION.later, input.applicationId),
      }),
    ],
  );
}

export function conflictScreen(input: { applicationId: string; step: number }): Component[] {
  return noticeScreen(
    'This step wasn’t saved',
    'Your answers changed somewhere else since you opened this step, so I kept the newer ' +
      'answers. Check them, then open the step again if you still want to change it.',
    [
      reviewButton(input.applicationId),
      stepButton(input.applicationId, input.step, 'Open step again'),
    ],
  );
}
