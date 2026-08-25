import { encodeCustomId, type Modal, TICKET_PRIORITIES, type TicketPriority } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import {
  FORM_FIELDS_MAX,
  MODULE_ID,
  PRIORITY_LABELS,
  type TicketFormField,
  type TicketType,
} from './config.ts';
import { CLOSE_REASON_ACTION, FORM_ACTION } from './interface.ts';
import type { TicketFormAnswer } from './store.ts';

export const PRIORITY_FIELD = '_priority';
export const SUBJECT_FIELD = '_subject';
export const REASON_FIELD = '_reason';
export const NAME_FIELD = '_name';
export const COMMENT_FIELD = '_comment';

export const RENAME_ACTION = 'renamem';
export const RATE_COMMENT_ACTION = 'ratec';

function labelled(label: string, component: Record<string, unknown>): Record<string, unknown> {
  return { type: ComponentType.Label, label: label.slice(0, 45), component };
}

function textInput(field: TicketFormField): Record<string, unknown> {
  return {
    type: ComponentType.TextInput,
    custom_id: field.id,
    style: field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short,
    required: field.required,
    max_length: field.maxLength ?? (field.style === 'paragraph' ? 1024 : 200),
    ...(field.placeholder ? { placeholder: field.placeholder.slice(0, 100) } : {}),
  };
}

function selectInput(field: TicketFormField): Record<string, unknown> {
  return {
    type: ComponentType.StringSelect,
    custom_id: field.id,
    required: field.required,
    ...(field.placeholder ? { placeholder: field.placeholder.slice(0, 100) } : {}),
    options: field.options.slice(0, 25).map((option) => ({
      label: option.label.slice(0, 100),
      value: option.value.slice(0, 100),
    })),
  };
}

function fieldComponent(field: TicketFormField): Record<string, unknown> | null {
  // A select with nothing to select is refused by Discord and would take the whole modal — and
  // with it the ticket — down with it.
  if (field.style === 'select' && field.options.length === 0) return null;

  return labelled(field.label, field.style === 'select' ? selectInput(field) : textInput(field));
}

export function modalFieldsFor(type: TicketType): TicketFormField[] {
  const usable = type.form.filter((field) => fieldComponent(field) !== null);

  // The priority picker costs one of Discord's five slots, so it displaces the last form field
  // rather than pushing the modal over the cap and being refused outright.
  return usable.slice(0, type.askPriority ? FORM_FIELDS_MAX - 1 : FORM_FIELDS_MAX);
}

export function needsModal(type: TicketType): boolean {
  return type.askPriority || modalFieldsFor(type).length > 0;
}

export function buildIntakeModal(panelId: string, type: TicketType): Modal | null {
  const customId = encodeCustomId(MODULE_ID, FORM_ACTION, panelId, type.id);
  if (!customId.ok) return null;

  const components: Record<string, unknown>[] = [];

  for (const field of modalFieldsFor(type)) {
    const component = fieldComponent(field);
    if (component) components.push(component);
  }

  if (type.askPriority) {
    components.push(
      labelled('How urgent is it?', {
        type: ComponentType.StringSelect,
        custom_id: PRIORITY_FIELD,
        required: false,
        options: TICKET_PRIORITIES.map((level) => ({
          label: PRIORITY_LABELS[level],
          value: level,
          default: level === type.defaultPriority,
        })),
      }),
    );
  }

  if (components.length === 0) return null;

  return { customId: customId.customId, title: type.name.slice(0, 45), components };
}

export interface IntakeAnswers {
  answers: TicketFormAnswer[];
  priority: TicketPriority | null;
  subject: string | null;
}

function isPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
}

export function readIntakeAnswers(
  type: TicketType,
  fields: Record<string, string>,
  values: Record<string, string[]>,
): IntakeAnswers {
  const answers: TicketFormAnswer[] = [];

  for (const [position, field] of modalFieldsFor(type).entries()) {
    const raw =
      field.style === 'select' ? (values[field.id]?.join(', ') ?? '') : (fields[field.id] ?? '');

    const value = raw.trim();
    if (value === '') continue;

    answers.push({ fieldId: field.id, label: field.label, value: value.slice(0, 4000), position });
  }

  const chosen = values[PRIORITY_FIELD]?.[0];

  return {
    answers,
    priority: chosen !== undefined && isPriority(chosen) ? chosen : null,
    // The first answer doubles as the subject line so a ticket list reads as something other than
    // a column of numbers; it is a copy, not a move, and the answer is still shown in full.
    subject: answers[0]?.value.slice(0, 200) ?? null,
  };
}

export function buildCloseReasonModal(): Modal | null {
  const customId = encodeCustomId(MODULE_ID, CLOSE_REASON_ACTION);
  if (!customId.ok) return null;

  return {
    customId: customId.customId,
    title: 'Close this ticket',
    components: [
      labelled('Why is it being closed? (optional)', {
        type: ComponentType.TextInput,
        custom_id: REASON_FIELD,
        style: TextInputStyle.Paragraph,
        required: false,
        max_length: 512,
        placeholder: 'Shown in the log and the transcript.',
      }),
    ],
  };
}

export function buildRenameModal(current: string): Modal | null {
  const customId = encodeCustomId(MODULE_ID, RENAME_ACTION);
  if (!customId.ok) return null;

  return {
    customId: customId.customId,
    title: 'Rename this ticket',
    components: [
      labelled('New channel name', {
        type: ComponentType.TextInput,
        custom_id: NAME_FIELD,
        style: TextInputStyle.Short,
        required: true,
        max_length: 100,
        value: current,
      }),
    ],
  };
}

export function buildRatingCommentModal(ticketId: string, score: number): Modal | null {
  const customId = encodeCustomId(MODULE_ID, RATE_COMMENT_ACTION, ticketId, String(score));
  if (!customId.ok) return null;

  return {
    customId: customId.customId,
    title: 'Thanks for rating',
    components: [
      labelled('Anything you would like to add? (optional)', {
        type: ComponentType.TextInput,
        custom_id: COMMENT_FIELD,
        style: TextInputStyle.Paragraph,
        required: false,
        max_length: 1000,
      }),
    ],
  };
}
