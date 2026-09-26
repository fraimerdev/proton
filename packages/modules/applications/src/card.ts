import {
  type ApplicationStatus,
  type InteractionMessage,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
} from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { fence, neutralise } from './answers-view.ts';
import type { FormConfig, REVIEW_CARD_MODES } from './config.ts';
import { CustomIdTooLongError, customId, MORE_CHOICES, STAFF_ACTION } from './interface.ts';
import type { CheckedAnswer } from './questions.ts';
import { allowedFrom, isFinal, STATUS_LABELS } from './status.ts';
import type { ApplicationRecord, EffectRecord, VoteRecord, VoteTally } from './store.ts';
import { EFFECT_PROBLEM_LABELS, type EffectProblem } from './view.ts';
import { referenceOf } from './web.ts';

export type CardMode = (typeof REVIEW_CARD_MODES)[number];

export interface ReviewCardInput {
  application: ApplicationRecord;
  form: Pick<FormConfig, 'review' | 'interview'>;
  formName: string;
  votes: VoteTally;
  problems: EffectProblem[];
  dashboardUrl: string | null;
  mode: CardMode;
  now: number;
  readOnly?: boolean | undefined;
  notice?: string | undefined;
  componentsMax?: number | undefined;
}

export type ReviewCard =
  | { ok: true; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

type Component = Record<string, unknown>;

export const CARD_TEXT_MAX = 3800;
export const CARD_COMPONENTS_MAX = 40;
export const FULL_ANSWERS_BUDGET = 3500;
export const SUMMARY_ANSWERS = 3;
export const SUMMARY_ANSWER_MAX = 300;
export const FULL_ANSWER_MAX = 1000;

const REASON_SHOWN_MAX = 300;
const NAME_SHOWN_MAX = 100;
const NOTICE_MAX = 200;
const ANSWERS_BUDGET_MIN = 200;
const TAIL_RESERVE = 240;

export const STATUS_ACCENTS: Readonly<Record<ApplicationStatus, number>> = {
  draft: 0x868e9f,
  submitted: 0xf0b752,
  in_review: 0x2a8af7,
  needs_info: 0xf0b752,
  waitlisted: 0x9aa4b5,
  accepted: 0x4fcf95,
  rejected: 0xff7a86,
  withdrawn: 0x868e9f,
  expired: 0x868e9f,
};

export const MORE_LABELS: Readonly<Record<keyof typeof MORE_CHOICES, string>> = {
  info: 'Request information…',
  waitlist: 'Waitlist…',
  note: 'Add note…',
  voteAccept: 'Vote accept',
  voteReject: 'Vote reject',
  ticket: 'Open interview ticket',
  read: 'Read all answers',
};

const MORE_DESCRIPTIONS: Readonly<Record<keyof typeof MORE_CHOICES, string>> = {
  info: 'Ask the applicant a question. They answer on their application.',
  waitlist: 'Put the decision off and let the applicant know.',
  note: 'Only the review team can read notes.',
  voteAccept: 'Say you’d accept. Votes inform the decision, they don’t make it.',
  voteReject: 'Say you’d reject. Votes inform the decision, they don’t make it.',
  ticket: 'Talk with the applicant in a ticket.',
  read: 'Every answer in full, a page at a time.',
};

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;

  let cut = Math.max(0, max - 1);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

// The applicant picks their display name, so it's escaped before it can become a link or mention.
export function plain(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_~|<>[\]#])/g, '\\$1');
}

export function relative(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function actorMention(id: string | null): string {
  return id !== null && /^\d{17,20}$/.test(id) ? `<@${id}>` : 'Proton';
}

export function reviewUrl(dashboardUrl: string, guildId: string, applicationId?: string): string {
  const base = `${dashboardUrl.replace(/\/$/, '')}/review/${guildId}`;
  return applicationId === undefined ? base : `${base}/${applicationId}`;
}

export function answerBlock(answer: CheckedAnswer, max: number): string {
  return `**${answer.label}**\n${fence(clip(neutralise(answer.display), max))}`;
}

export function effectProblems(effects: readonly EffectRecord[]): EffectProblem[] {
  return effects
    .filter((effect) => effect.status === 'failed')
    .map((effect) => ({
      effectId: effect.id,
      kind: effect.kind,
      label: EFFECT_PROBLEM_LABELS[effect.kind],
    }));
}

export function voteTally(votes: readonly Pick<VoteRecord, 'vote'>[]): VoteTally {
  const tally: VoteTally = { accept: 0, reject: 0 };
  for (const { vote } of votes) tally[vote] += 1;
  return tally;
}

export function votingOn(form: Pick<FormConfig, 'review'>): boolean {
  return form.review.requireTwoReviewers || form.review.scoring;
}

export function cardMessage(components: Record<string, unknown>[]): InteractionMessage {
  return { components, flags: MESSAGE_FLAG_IS_COMPONENTS_V2, allowedMentions: { parse: [] } };
}

function text(content: string): Component {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): Component {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function button(style: ButtonStyle, label: string, custom: string): Component {
  return { type: ComponentType.Button, style, label, custom_id: custom };
}

function link(label: string, url: string): Component {
  return { type: ComponentType.Button, style: ButtonStyle.Link, label, url };
}

function row(...components: Component[]): Component {
  return { type: ComponentType.ActionRow, components };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function statusParts(input: ReviewCardInput): string[] {
  const { application, form, votes } = input;
  const { status } = application;
  const parts = [`**${STATUS_LABELS[status]}**`];

  if (status === 'accepted' || status === 'rejected') {
    parts[0] += ` by ${actorMention(application.decidedBy)}`;
    if (application.decidedAt !== null) parts[0] += ` ${relative(application.decidedAt)}`;
  } else if (status === 'withdrawn') {
    parts[0] += ' by the applicant';
    if (application.withdrawnAt !== null) parts[0] += ` ${relative(application.withdrawnAt)}`;
  } else if (application.assigneeId !== null && !isFinal(status)) {
    parts.push(`claimed by ${actorMention(application.assigneeId)}`);
  }

  if (status === 'needs_info' && application.infoDueAt !== null) {
    parts.push(`answer due ${relative(application.infoDueAt)}`);
  }

  const cast = votes.accept + votes.reject;
  const twoReviewers = form.review.requireTwoReviewers && !isFinal(status);
  if (cast > 0) {
    parts.push(`Votes: ${votes.accept} accept · ${votes.reject} reject`);
  } else if (twoReviewers) {
    parts.push('Votes: none yet');
  }
  if (twoReviewers) parts.push('two reviewers must agree');
  if (application.archivedAt !== null) parts.push('archived');

  return parts;
}

function summaryText(input: ReviewCardInput): string {
  const { application, formName } = input;
  const lines = [`## ${clip(formName, NAME_SHOWN_MAX)} ${referenceOf(application.number)}`.trim()];

  const mention = `<@${application.applicantId}>`;
  const name = application.applicantName?.trim();
  lines.push(name ? `${mention} · ${plain(clip(name, NAME_SHOWN_MAX))}` : mention);
  lines.push(statusParts(input).join(' · '));

  const sent: string[] = [];
  if (application.submittedAt !== null) {
    sent.push(`Submitted ${relative(application.submittedAt)}`);
  }
  if (application.reopenedCount > 0) {
    sent.push(`reopened ${plural(application.reopenedCount, 'time')}`);
  }
  if (sent.length > 0) lines.push(sent.join(' · '));

  if (application.interviewChannelId !== null) {
    lines.push(`Interview ticket: <#${application.interviewChannelId}>`);
  }

  const notice = input.notice?.trim();
  if (notice) lines.push(`-# ${clip(notice, NOTICE_MAX)}`);

  return lines.join('\n');
}

function reasonText(application: ApplicationRecord): string | null {
  const reason = application.decisionReason?.trim();
  const shown: readonly ApplicationStatus[] = ['accepted', 'rejected', 'waitlisted'];
  if (!reason || !shown.includes(application.status)) return null;

  return `**Reason sent to the applicant**\n${fence(clip(neutralise(reason), REASON_SHOWN_MAX))}`;
}

function problemText(problems: readonly EffectProblem[], dashboard: boolean): string | null {
  if (problems.length === 0) return null;

  const labels = [...new Set(problems.map((problem) => problem.label))];
  const retry = dashboard ? ' Retry from the dashboard.' : '';
  return `**Needs attention:** ${labels.join(' · ')}.${retry}`;
}

interface Answers {
  blocks: string[];
  tail: string | null;
}

function readHint(input: ReviewCardInput, interactive: boolean): string {
  const where = interactive
    ? 'Choose **Read all answers** under More actions'
    : 'Press **Read all answers**';
  return input.dashboardUrl === null ? `${where}.` : `${where}, or open the dashboard.`;
}

function answerSection(input: ReviewCardInput, budget: number, interactive: boolean): Answers {
  const { application } = input;
  const answers = application.answers;

  if (answers === null) {
    const purgedAt = application.contentPurgedAt;
    return {
      blocks: [],
      tail:
        purgedAt === null
          ? 'There are no answers to show.'
          : `The answers were removed ${relative(purgedAt)}, after this server’s keep-for period.`,
    };
  }

  if (answers.length === 0) return { blocks: [], tail: 'No questions were answered.' };

  if (input.mode === 'none' || budget < ANSWERS_BUDGET_MIN) {
    const count =
      answers.length === 1 ? 'The answer isn’t' : `The ${answers.length} answers aren’t`;
    return { blocks: [], tail: `${count} shown on this card. ${readHint(input, interactive)}` };
  }

  const wanted = input.mode === 'summary' ? answers.slice(0, SUMMARY_ANSWERS) : answers;
  const max = input.mode === 'summary' ? SUMMARY_ANSWER_MAX : FULL_ANSWER_MAX;
  const limit = Math.min(budget, input.mode === 'full' ? FULL_ANSWERS_BUDGET : budget);

  const blocks: string[] = [];
  let used = 0;
  let clipped = false;

  for (const answer of wanted) {
    const piece = answerBlock(answer, max);
    if (used + piece.length + 1 > limit) break;

    blocks.push(piece);
    used += piece.length + 1;
    if (neutralise(answer.display).length > max) clipped = true;
  }

  const hidden = answers.length - blocks.length;
  if (hidden === 0 && !clipped) return { blocks, tail: null };

  const lines: string[] = [];
  if (hidden > 0) lines.push(`…and ${plural(hidden, 'more answer')}.`);
  if (clipped) lines.push('Long answers are cut short here.');
  lines.push(readHint(input, interactive));

  return { blocks, tail: lines.join(' ') };
}

function pack(blocks: readonly string[], slots: number): string[] {
  if (blocks.length <= slots) return [...blocks];
  if (slots <= 0) return [];

  const size = Math.ceil(blocks.length / slots);
  const packed: string[] = [];
  for (let at = 0; at < blocks.length; at += size) {
    packed.push(blocks.slice(at, at + size).join('\n'));
  }
  return packed;
}

function moreSelect(input: ReviewCardInput, applicationId: string): Component | null {
  const { application, form } = input;
  const { status } = application;

  const choices: (keyof typeof MORE_CHOICES)[] = [];
  if (allowedFrom('request_info').includes(status)) choices.push('info');
  if (allowedFrom('waitlist').includes(status)) choices.push('waitlist');
  if (allowedFrom('note').includes(status)) choices.push('note');
  if (votingOn(form) && allowedFrom('vote').includes(status)) {
    choices.push('voteAccept', 'voteReject');
  }
  if (form.interview.ticketTypeId !== undefined && allowedFrom('open_ticket').includes(status)) {
    choices.push('ticket');
  }
  if (application.answers !== null) choices.push('read');

  if (choices.length === 0) return null;

  return row({
    type: ComponentType.StringSelect,
    custom_id: customId(STAFF_ACTION.more, applicationId),
    placeholder: 'More actions',
    min_values: 1,
    max_values: 1,
    options: choices.map((choice) => ({
      label: MORE_LABELS[choice],
      value: MORE_CHOICES[choice],
      description: MORE_DESCRIPTIONS[choice],
    })),
  });
}

function actionRows(input: ReviewCardInput, interactive: boolean): Component[] {
  const { application, dashboardUrl } = input;
  const { id } = application;
  const dashboard =
    dashboardUrl === null
      ? null
      : link('Open in dashboard', reviewUrl(dashboardUrl, application.guildId, id));

  if (!interactive) {
    const buttons: Component[] = [];
    if (application.answers !== null) {
      buttons.push(
        button(ButtonStyle.Secondary, 'Read all answers', customId(STAFF_ACTION.read, id)),
      );
    }
    if (dashboard !== null) buttons.push(dashboard);
    return buttons.length === 0 ? [] : [row(...buttons)];
  }

  const decision: Component[] = [];
  if (allowedFrom('unclaim').includes(application.status)) {
    decision.push(button(ButtonStyle.Secondary, 'Unclaim', customId(STAFF_ACTION.unclaim, id)));
  } else if (application.assigneeId === null && allowedFrom('claim').includes(application.status)) {
    decision.push(button(ButtonStyle.Primary, 'Claim', customId(STAFF_ACTION.claim, id)));
  }
  decision.push(
    button(ButtonStyle.Success, 'Accept…', customId(STAFF_ACTION.accept, id)),
    button(ButtonStyle.Danger, 'Reject…', customId(STAFF_ACTION.reject, id)),
  );
  if (dashboard !== null) decision.push(dashboard);

  const more = moreSelect(input, id);
  return more === null ? [row(...decision)] : [row(...decision), more];
}

function countComponents(components: readonly Component[]): number {
  let total = 0;
  for (const component of components) {
    total += 1;
    const children = component.components;
    if (Array.isArray(children)) total += countComponents(children as Component[]);
    const accessory = component.accessory;
    if (accessory !== undefined && accessory !== null) total += 1;
  }
  return total;
}

export function cardComponentCount(components: readonly Component[]): number {
  return countComponents(components);
}

export function cardTextLength(components: readonly Component[]): number {
  let total = 0;
  for (const component of components) {
    if (component.type === ComponentType.TextDisplay && typeof component.content === 'string') {
      total += component.content.length;
    }
    const children = component.components;
    if (Array.isArray(children)) total += cardTextLength(children as Component[]);
  }
  return total;
}

export function buildReviewCard(input: ReviewCardInput): ReviewCard {
  const { application } = input;

  if (application.deletedAt !== null) {
    return {
      ok: false,
      humanReason: `Application ${referenceOf(application.number)} was deleted, so there’s no card to show.`,
    };
  }
  if (application.status === 'draft' || application.number === null) {
    return {
      ok: false,
      humanReason: 'This application hasn’t been sent yet, so there’s no card to show.',
    };
  }

  const interactive = !isFinal(application.status) && input.readOnly !== true;

  try {
    const head = [
      summaryText(input),
      reasonText(application),
      problemText(input.problems, input.dashboardUrl !== null),
    ].filter((piece): piece is string => piece !== null);

    const headLength = head.reduce((sum, piece) => sum + piece.length, 0);
    const answers = answerSection(input, CARD_TEXT_MAX - headLength - TAIL_RESERVE, interactive);
    const rows = actionRows(input, interactive);

    const fixed =
      2 +
      head.length +
      (answers.tail === null ? 0 : 1) +
      (rows.length === 0 ? 0 : 1 + countComponents(rows));
    const blocks = pack(answers.blocks, (input.componentsMax ?? CARD_COMPONENTS_MAX) - fixed);

    const children: Component[] = [
      ...head.map(text),
      separator(),
      ...blocks.map(text),
      ...(answers.tail === null ? [] : [text(answers.tail)]),
      ...(rows.length > 0 ? [separator(), ...rows] : []),
    ];

    const container: Component = {
      type: ComponentType.Container,
      accent_color: STATUS_ACCENTS[application.status],
      components: children,
    };

    return { ok: true, components: [container] };
  } catch (error) {
    if (error instanceof CustomIdTooLongError) return { ok: false, humanReason: error.message };
    throw error;
  }
}
