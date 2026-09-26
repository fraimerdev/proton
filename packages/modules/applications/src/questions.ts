import { z } from 'zod';
import {
  CONDITION_SOURCE_TYPES,
  CONFIRM_VALUE,
  type FlatQuestion,
  QUESTION_TYPES,
  type Question,
  questionsOf,
  type Section,
  type UrlScheme,
} from './config.ts';
import {
  OPTION_VALUE_MAX,
  OPTIONS_MAX,
  QUESTION_ID_MAX,
  QUESTIONS_PER_FORM_MAX,
  QUESTIONS_PER_STEP,
  SECTION_ID_MAX,
  SLUG,
  TEXT_ANSWER_MAX,
} from './constants.ts';

export const URL_ANSWER_MAX = 2048;

export const rawAnswerSchema = z.union([
  z.string().max(TEXT_ANSWER_MAX),
  z.array(z.string().min(1).max(OPTION_VALUE_MAX)).max(OPTIONS_MAX),
  z.boolean(),
]);
export type RawAnswer = z.infer<typeof rawAnswerSchema>;

export const draftAnswersSchema = z
  .record(z.string().max(QUESTION_ID_MAX).regex(SLUG), rawAnswerSchema)
  .refine((answers) => Object.keys(answers).length <= QUESTIONS_PER_FORM_MAX, {
    message: `A form has at most ${QUESTIONS_PER_FORM_MAX} questions.`,
  });
export type DraftAnswers = z.infer<typeof draftAnswersSchema>;

export const checkedAnswerSchema = z.object({
  questionId: z.string().min(1).max(QUESTION_ID_MAX),
  sectionId: z.string().min(1).max(SECTION_ID_MAX),
  label: z.string(),
  type: z.enum(QUESTION_TYPES),
  value: rawAnswerSchema,
  display: z.string(),
});
export type CheckedAnswer = z.infer<typeof checkedAnswerSchema>;

export const answerProblemSchema = z.object({
  questionId: z.string(),
  label: z.string(),
  message: z.string(),
});
export type AnswerProblem = z.infer<typeof answerProblemSchema>;

export type AnswerCheck =
  | { ok: true; value: RawAnswer | null; display: string }
  | { ok: false; message: string };

export type AnswersCheck =
  | { ok: true; answers: CheckedAnswer[] }
  | { ok: false; problems: AnswerProblem[]; answers: CheckedAnswer[] };

export interface Step {
  index: number;
  sectionId: string;
  title: string;
  description: string;
  questions: FlatQuestion[];
}

type QuestionLookup = ReadonlyMap<string, Question>;

export function answerOf(answers: DraftAnswers, questionId: string): RawAnswer | undefined {
  return Object.hasOwn(answers, questionId) ? answers[questionId] : undefined;
}

function conditionMet(
  source: Question,
  values: readonly string[],
  raw: RawAnswer | undefined,
): boolean {
  if (!CONDITION_SOURCE_TYPES.includes(source.type)) return false;

  const checked = checkAnswer(source, raw);
  if (!checked.ok || checked.value === null) return false;

  const { value } = checked;
  if (value === true) return values.includes(CONFIRM_VALUE);
  if (typeof value === 'string') return values.includes(value);
  return Array.isArray(value) && value.some((choice) => values.includes(choice));
}

function visibleFrom(
  question: Pick<Question, 'id' | 'showIf'>,
  answers: DraftAnswers,
  byId: QuestionLookup,
  seen: ReadonlySet<string>,
): boolean {
  const condition = question.showIf;
  if (condition === undefined) return true;
  if (seen.has(question.id)) return false;

  const source = byId.get(condition.questionId);
  if (source === undefined) return false;

  const chain = new Set(seen).add(question.id);
  if (!visibleFrom(source, answers, byId, chain)) return false;

  return conditionMet(source, condition.values, answerOf(answers, source.id));
}

export function isVisible(
  question: Pick<Question, 'id' | 'showIf'>,
  answers: DraftAnswers,
  byId: QuestionLookup,
): boolean {
  return visibleFrom(question, answers, byId, new Set());
}

function lookupOf(flat: readonly FlatQuestion[]): Map<string, FlatQuestion> {
  const byId = new Map<string, FlatQuestion>();
  for (const question of flat) {
    if (!byId.has(question.id)) byId.set(question.id, question);
  }
  return byId;
}

export function visibleQuestions(
  sections: readonly Section[],
  answers: DraftAnswers,
): FlatQuestion[] {
  const flat = questionsOf({ sections });
  const byId = lookupOf(flat);
  return flat.filter((question) => isVisible(question, answers, byId));
}

function confirmed(raw: RawAnswer | undefined): boolean {
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === CONFIRM_VALUE || raw === 'true';
  return Array.isArray(raw) && raw.includes(CONFIRM_VALUE);
}

function numberSentence(limits: {
  min?: number | undefined;
  max?: number | undefined;
  integer: boolean;
}): string {
  const noun = limits.integer ? 'a whole number' : 'a number';
  const { min, max } = limits;

  if (min !== undefined && max !== undefined) return `Enter ${noun} from ${min} to ${max}.`;
  if (min !== undefined) return `Enter ${noun} of ${min} or more.`;
  if (max !== undefined) return `Enter ${noun} of ${max} or less.`;
  return `Enter ${noun}.`;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const NUMBER_TEXT_MAX = 40;

export function parseNumber(
  raw: string,
  limits: { min?: number | undefined; max?: number | undefined; integer: boolean },
): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.trim();
  const refusal = { ok: false as const, message: numberSentence(limits) };

  if (text.length === 0 || text.length > NUMBER_TEXT_MAX || !NUMBER.test(text)) return refusal;

  const value = Number(text);
  if (!Number.isFinite(value)) return refusal;
  if (limits.integer && !Number.isInteger(value)) return refusal;
  if (limits.min !== undefined && value < limits.min) return refusal;
  if (limits.max !== undefined && value > limits.max) return refusal;

  return { ok: true, value };
}

function listOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

function schemeSentence(schemes: readonly UrlScheme[]): string {
  const ordered = (['https', 'http'] as const).filter((scheme) => schemes.includes(scheme));
  return `Enter a link that starts with ${listOr(ordered.map((scheme) => `${scheme}://`))}.`;
}

// A colon followed by a digit is a port, so "example.com:8080" still gets https:// in front.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

export function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return true;

  const host = hostname.toLowerCase().replace(/\.$/, '');
  return hosts.some((allowed) => {
    const wanted = allowed.toLowerCase().replace(/\.$/, '');
    return host === wanted || host.endsWith(`.${wanted}`);
  });
}

export function normaliseUrl(
  raw: string,
  schemes: readonly UrlScheme[],
  hosts: readonly string[],
): { ok: true; url: string } | { ok: false; message: string } {
  const text = raw.trim();
  const wanted = { ok: false as const, message: schemeSentence(schemes) };

  if (text === '' || /\s/.test(text)) return wanted;

  const fallback = schemes.includes('https') ? 'https' : 'http';
  const candidate = HAS_SCHEME.test(text) ? text : `${fallback}://${text}`;
  if (!URL.canParse(candidate)) return wanted;

  const url = new URL(candidate);
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!schemes.some((allowed) => allowed === scheme)) return wanted;

  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: 'Enter a link without a username or password in it.' };
  }

  if (!url.hostname.includes('.') || url.hostname.startsWith('[')) {
    return { ok: false, message: 'Enter a full link, like https://example.com.' };
  }

  if (!hostAllowed(url.hostname, hosts)) {
    return { ok: false, message: `Enter a link to ${listOr(hosts)}.` };
  }

  if (url.href.length > URL_ANSWER_MAX) {
    return { ok: false, message: `Use a link of ${URL_ANSWER_MAX} characters or fewer.` };
  }

  return { ok: true, url: url.href };
}

function optionLabel(question: Pick<Question, 'options'>, value: string): string {
  return question.options.find((option) => option.value === value)?.label ?? value;
}

export function displayAnswer(
  question: Pick<Question, 'type' | 'options'>,
  value: RawAnswer | null | undefined,
): string {
  if (value === null || value === undefined) return '';

  switch (question.type) {
    case 'confirm':
      return value === true ? 'Confirmed' : '';
    case 'single':
    case 'multiple': {
      const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      return values.map((choice) => optionLabel(question, choice)).join(', ');
    }
    default:
      return typeof value === 'string' ? value : '';
  }
}

const EMPTY = { ok: true as const, value: null, display: '' };

function textAnswer(question: Question, raw: RawAnswer | undefined): AnswerCheck {
  if (raw === undefined) return EMPTY;
  if (typeof raw !== 'string') return { ok: false, message: 'Answer this with text.' };

  const text = (question.type === 'paragraph' ? raw.replace(/\r\n?/g, '\n') : raw).trim();
  if (text === '') return EMPTY;

  const max = Math.min(question.maxLength ?? TEXT_ANSWER_MAX, TEXT_ANSWER_MAX);
  if (text.length > max) {
    return {
      ok: false,
      message: `Use ${max} characters or fewer. This answer has ${text.length}.`,
    };
  }

  if (question.minLength !== undefined && text.length < question.minLength) {
    return {
      ok: false,
      message: `Use at least ${question.minLength} characters. This answer has ${text.length}.`,
    };
  }

  return { ok: true, value: text, display: text };
}

function numberAnswer(question: Question, raw: RawAnswer | undefined): AnswerCheck {
  if (raw === undefined) return EMPTY;

  const limits = { min: question.min, max: question.max, integer: question.integer };
  if (typeof raw !== 'string') return { ok: false, message: numberSentence(limits) };

  const text = raw.trim();
  if (text === '') return EMPTY;

  const parsed = parseNumber(text, limits);
  return parsed.ok ? { ok: true, value: text, display: text } : parsed;
}

function urlAnswer(question: Question, raw: RawAnswer | undefined): AnswerCheck {
  if (raw === undefined) return EMPTY;
  if (typeof raw !== 'string') return { ok: false, message: schemeSentence(question.schemes) };

  const text = raw.trim();
  if (text === '') return EMPTY;

  const normalised = normaliseUrl(text, question.schemes, question.hosts);
  return normalised.ok ? { ok: true, value: normalised.url, display: normalised.url } : normalised;
}

function choicesOf(raw: RawAnswer | undefined): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  if (Array.isArray(raw)) return raw;
  return null;
}

function singleAnswer(question: Question, raw: RawAnswer | undefined): AnswerCheck {
  const choices = choicesOf(raw);
  if (choices === null) return { ok: false, message: 'Choose one of the options.' };
  if (choices.length === 0) return EMPTY;
  if (choices.length > 1) return { ok: false, message: 'Choose only one option.' };

  const [value = ''] = choices;
  if (!question.options.some((option) => option.value === value)) {
    return { ok: false, message: 'Choose one of the options.' };
  }

  return { ok: true, value, display: optionLabel(question, value) };
}

function choiceCountSentence(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) {
    return min === max ? `Choose exactly ${min}.` : `Choose from ${min} to ${max}.`;
  }
  if (min !== undefined) return `Choose at least ${min}.`;
  return `Choose at most ${max}.`;
}

function multipleAnswer(question: Question, raw: RawAnswer | undefined): AnswerCheck {
  const choices = choicesOf(raw);
  if (choices === null) return { ok: false, message: 'Choose from the options given.' };
  if (choices.length === 0) return EMPTY;

  const picked = new Set(choices);
  const known = new Set(question.options.map((option) => option.value));
  if ([...picked].some((value) => !known.has(value))) {
    return { ok: false, message: 'Choose from the options given.' };
  }

  const { minChoices, maxChoices } = question;
  if (
    (minChoices !== undefined && picked.size < minChoices) ||
    (maxChoices !== undefined && picked.size > maxChoices)
  ) {
    return { ok: false, message: choiceCountSentence(minChoices, maxChoices) };
  }

  const value = question.options.map((option) => option.value).filter((v) => picked.has(v));
  return { ok: true, value, display: displayAnswer(question, value) };
}

function confirmAnswer(raw: RawAnswer | undefined): AnswerCheck {
  return confirmed(raw) ? { ok: true, value: true, display: 'Confirmed' } : EMPTY;
}

export function checkAnswer(question: Question, raw: RawAnswer | undefined): AnswerCheck {
  switch (question.type) {
    case 'short':
    case 'paragraph':
      return textAnswer(question, raw);
    case 'number':
      return numberAnswer(question, raw);
    case 'url':
      return urlAnswer(question, raw);
    case 'single':
      return singleAnswer(question, raw);
    case 'multiple':
      return multipleAnswer(question, raw);
    case 'confirm':
      return confirmAnswer(raw);
  }
}

function needsAnswer(label: string): string {
  return `“${label}” needs an answer.`;
}

export function checkAnswers(
  sections: readonly Section[],
  answers: DraftAnswers,
  options: { partial: boolean },
): AnswersCheck {
  const problems: AnswerProblem[] = [];
  const checked: CheckedAnswer[] = [];

  for (const question of visibleQuestions(sections, answers)) {
    const result = checkAnswer(question, answerOf(answers, question.id));
    const { id: questionId, label } = question;

    if (!result.ok) {
      problems.push({ questionId, label, message: result.message });
      continue;
    }

    if (result.value === null) {
      if (question.required && !options.partial) {
        problems.push({ questionId, label, message: needsAnswer(label) });
      }
      continue;
    }

    checked.push({
      questionId,
      sectionId: question.sectionId,
      label,
      type: question.type,
      value: result.value,
      display: result.display,
    });
  }

  return problems.length === 0
    ? { ok: true, answers: checked }
    : { ok: false, problems, answers: checked };
}

export function pruneHidden(sections: readonly Section[], answers: DraftAnswers): DraftAnswers {
  const pruned: DraftAnswers = {};

  for (const question of visibleQuestions(sections, answers)) {
    const raw = answerOf(answers, question.id);
    if (raw !== undefined) pruned[question.id] = raw;
  }

  return pruned;
}

// Chunk hidden questions too, so answering a step never regroups that step or the ones before it.
export function stepsFor(sections: readonly Section[], answers: DraftAnswers): Step[] {
  const flat = questionsOf({ sections });
  const byId = lookupOf(flat);
  const steps: Step[] = [];

  for (const section of sections) {
    const chunks: FlatQuestion[][] = [];
    let current: FlatQuestion[] = [];

    for (const question of section.questions) {
      const source = question.showIf?.questionId;
      const split =
        current.length >= QUESTIONS_PER_STEP ||
        (source !== undefined && current.some((held) => held.id === source));

      if (split && current.length > 0) {
        chunks.push(current);
        current = [];
      }
      current.push({ ...question, sectionId: section.id });
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const visible = chunk.filter((question) => isVisible(question, answers, byId));
      if (visible.length === 0) continue;

      steps.push({
        index: steps.length,
        sectionId: section.id,
        title: section.title,
        description: section.description,
        questions: visible,
      });
    }
  }

  return steps;
}
