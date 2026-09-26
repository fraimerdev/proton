import type { Modal } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { CONFIRM_VALUE, type FlatQuestion, type QuestionOption } from './config.ts';
import {
  INFO_RESPONSE_MAX,
  OPTION_VALUE_MAX,
  OPTIONS_MAX,
  RADIO_OPTIONS_MAX,
  TEXT_ANSWER_MAX,
} from './constants.ts';
import { APPLICANT_ACTION, customId } from './interface.ts';
import {
  answerOf,
  type DraftAnswers,
  type RawAnswer,
  type Step,
  URL_ANSWER_MAX,
} from './questions.ts';

export const MODAL_TITLE_MAX = 45;
export const LABEL_MAX = 45;
export const LABEL_DESCRIPTION_MAX = 100;
export const PLACEHOLDER_MAX = 100;
export const NUMBER_INPUT_MAX = 40;
export const RESPONSE_FIELD = 'response';

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;

  const marked = max > 1;
  let cut = Math.max(0, marked ? max - 1 : max);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return marked ? `${text.slice(0, cut)}…` : text.slice(0, cut);
}

export function stepTitle(formName: string, index: number, count: number): string {
  if (count <= 1) return clip(formName, MODAL_TITLE_MAX);

  const prefix = `Step ${index + 1} of ${count}`;
  const room = MODAL_TITLE_MAX - prefix.length - 3;
  return room < 4 ? prefix : `${prefix} · ${clip(formName, room)}`;
}

function labelled(
  label: string,
  description: string,
  component: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: ComponentType.Label,
    label: clip(label, LABEL_MAX),
    ...(description === '' ? {} : { description: clip(description, LABEL_DESCRIPTION_MAX) }),
    component,
  };
}

function textOf(raw: RawAnswer | undefined): string {
  return typeof raw === 'string' ? raw : '';
}

function chosenOf(raw: RawAnswer | undefined): string[] {
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  return Array.isArray(raw) ? raw : [];
}

function confirmedOf(raw: RawAnswer | undefined): boolean {
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === CONFIRM_VALUE;
  return Array.isArray(raw) && raw.includes(CONFIRM_VALUE);
}

function inputLimit(question: FlatQuestion): number {
  switch (question.type) {
    case 'number':
      return NUMBER_INPUT_MAX;
    case 'url':
      return URL_ANSWER_MAX;
    default:
      return Math.min(question.maxLength ?? TEXT_ANSWER_MAX, TEXT_ANSWER_MAX);
  }
}

function textInput(question: FlatQuestion, raw: RawAnswer | undefined): Record<string, unknown> {
  const prefill = textOf(raw).slice(0, TEXT_ANSWER_MAX);
  const minimum =
    question.required && (question.type === 'short' || question.type === 'paragraph')
      ? Math.max(1, question.minLength ?? 1)
      : undefined;
  // Widened to fit the saved answer, so an answer the server refused comes back whole to be fixed.
  const maximum = Math.min(
    TEXT_ANSWER_MAX,
    Math.max(inputLimit(question), prefill.length, minimum ?? 1),
  );

  return {
    type: ComponentType.TextInput,
    custom_id: question.id,
    style: question.type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short,
    required: question.required,
    ...(minimum === undefined ? {} : { min_length: minimum }),
    max_length: maximum,
    ...(question.placeholder === ''
      ? {}
      : { placeholder: clip(question.placeholder, PLACEHOLDER_MAX) }),
    ...(prefill === '' ? {} : { value: prefill }),
  };
}

function optionsOf(
  options: readonly QuestionOption[],
  chosen: readonly string[],
): Record<string, unknown>[] {
  return options.slice(0, OPTIONS_MAX).map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.description === '' ? {} : { description: option.description }),
    ...(chosen.includes(option.value) ? { default: true } : {}),
  }));
}

function singleInput(question: FlatQuestion, raw: RawAnswer | undefined): Record<string, unknown> {
  const chosen = chosenOf(raw).slice(0, 1);
  const options = optionsOf(question.options, chosen);

  if (question.options.length >= 2 && question.options.length <= RADIO_OPTIONS_MAX) {
    return {
      type: ComponentType.RadioGroup,
      custom_id: question.id,
      required: question.required,
      options,
    };
  }

  return {
    type: ComponentType.StringSelect,
    custom_id: question.id,
    required: question.required,
    min_values: question.required ? 1 : 0,
    max_values: 1,
    placeholder: clip(question.placeholder === '' ? 'Choose one' : question.placeholder, 150),
    options,
  };
}

function multipleInput(
  question: FlatQuestion,
  raw: RawAnswer | undefined,
): Record<string, unknown> {
  const count = Math.min(question.options.length, OPTIONS_MAX);
  const chosen = chosenOf(raw);
  const minimum = question.required ? Math.min(count, Math.max(1, question.minChoices ?? 1)) : 0;
  const maximum = Math.max(minimum, 1, Math.min(question.maxChoices ?? count, count));
  const options = optionsOf(question.options, chosen);

  if (count <= RADIO_OPTIONS_MAX) {
    return {
      type: ComponentType.CheckboxGroup,
      custom_id: question.id,
      required: question.required,
      min_values: minimum,
      max_values: maximum,
      options,
    };
  }

  return {
    type: ComponentType.StringSelect,
    custom_id: question.id,
    required: question.required,
    min_values: minimum,
    max_values: maximum,
    placeholder: clip(question.placeholder === '' ? 'Choose' : question.placeholder, 150),
    options,
  };
}

// A lone Checkbox cannot be required, so a confirmation is a one-option Checkbox Group.
function confirmInput(question: FlatQuestion, raw: RawAnswer | undefined): Record<string, unknown> {
  return {
    type: ComponentType.CheckboxGroup,
    custom_id: question.id,
    required: question.required,
    min_values: question.required ? 1 : 0,
    max_values: 1,
    options: [
      { label: 'Yes', value: CONFIRM_VALUE, ...(confirmedOf(raw) ? { default: true } : {}) },
    ],
  };
}

export function questionComponent(
  question: FlatQuestion,
  raw: RawAnswer | undefined,
): Record<string, unknown> {
  switch (question.type) {
    case 'short':
    case 'paragraph':
    case 'number':
    case 'url':
      return labelled(question.label, question.help, textInput(question, raw));
    case 'single':
      return labelled(question.label, question.help, singleInput(question, raw));
    case 'multiple':
      return labelled(question.label, question.help, multipleInput(question, raw));
    case 'confirm':
      return labelled(question.label, question.help, confirmInput(question, raw));
  }
}

export interface StepModalInput {
  applicationId: string;
  revision: number;
  draft: DraftAnswers;
  formName: string;
  step: Step;
  stepCount: number;
}

export function buildStepModal(input: StepModalInput): Modal {
  const { step } = input;

  return {
    customId: customId(
      APPLICANT_ACTION.answer,
      input.applicationId,
      String(step.index),
      String(input.revision),
    ),
    title: stepTitle(input.formName, step.index, input.stepCount),
    components: step.questions
      .slice(0, 5)
      .map((question) => questionComponent(question, answerOf(input.draft, question.id))),
  };
}

export interface ModalAnswers {
  fields: Readonly<Record<string, string>>;
  values: Readonly<Record<string, readonly string[]>>;
  checks: Readonly<Record<string, boolean>>;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function choices(raw: readonly string[] | undefined): string[] {
  const kept = (raw ?? []).filter((value) => value.length > 0 && value.length <= OPTION_VALUE_MAX);
  return [...new Set(kept)].slice(0, OPTIONS_MAX);
}

// Empty answers are written too, or a merge would keep the answer the member just cleared.
export function readStepAnswers(step: Step, modal: ModalAnswers): DraftAnswers {
  const answers: DraftAnswers = {};

  for (const question of step.questions.slice(0, 5)) {
    const { id } = question;

    switch (question.type) {
      case 'short':
      case 'paragraph':
      case 'number':
      case 'url':
        answers[id] = (own(modal.fields, id) ?? '').slice(0, TEXT_ANSWER_MAX);
        break;
      case 'single':
        answers[id] = (own(modal.fields, id) ?? choices(own(modal.values, id))[0] ?? '').slice(
          0,
          TEXT_ANSWER_MAX,
        );
        break;
      case 'multiple':
        answers[id] = choices(own(modal.values, id));
        break;
      case 'confirm':
        answers[id] =
          choices(own(modal.values, id)).includes(CONFIRM_VALUE) || own(modal.checks, id) === true;
        break;
    }
  }

  return answers;
}

export function buildRespondModal(input: {
  applicationId: string;
  revision: number;
  formName: string;
}): Modal {
  return {
    customId: customId(APPLICANT_ACTION.respondModal, input.applicationId, String(input.revision)),
    title: clip(`Answer staff · ${input.formName}`, MODAL_TITLE_MAX),
    components: [
      labelled('Your answer', 'Staff reviewing your application will read this.', {
        type: ComponentType.TextInput,
        custom_id: RESPONSE_FIELD,
        style: TextInputStyle.Paragraph,
        required: true,
        min_length: 1,
        max_length: INFO_RESPONSE_MAX,
      }),
    ],
  };
}

export function readResponse(modal: Pick<ModalAnswers, 'fields'>): string {
  return (own(modal.fields, RESPONSE_FIELD) ?? '').replace(/\r\n?/g, '\n').trim();
}
