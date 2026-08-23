import {
  POLL_MAX_ANSWER_LENGTH,
  POLL_MAX_ANSWERS,
  POLL_MAX_DURATION_HOURS,
  POLL_MAX_QUESTION_LENGTH,
  type sendPayloadSchema,
} from '@proton/core';
import type { z } from 'zod';
import { POLL_MIN_DURATION_HOURS } from './config.ts';

export const ANSWER_SEPARATOR = '|';

export const POLL_MIN_ANSWERS = 2;

export type PollRequest = NonNullable<z.infer<typeof sendPayloadSchema>['poll']>;

export interface ComposeInput {
  question: string;
  answers: string;
  durationHours: number;
  multiselect: boolean;
}

export type ComposeResult = { ok: true; poll: PollRequest } | { ok: false; humanReason: string };

const SEPARATOR_HINT =
  `Put a \`${ANSWER_SEPARATOR}\` between the answers, like ` +
  `\`Yes ${ANSWER_SEPARATOR} No ${ANSWER_SEPARATOR} Ask me later\`.`;

export function splitAnswers(raw: string): string[] {
  return raw
    .split(ANSWER_SEPARATOR)
    .map((answer) => answer.trim())
    .filter((answer) => answer.length > 0);
}

export function composePoll(input: ComposeInput): ComposeResult {
  const question = input.question.trim();

  if (question.length === 0) {
    return { ok: false, humanReason: 'A poll needs a question, and that one was empty.' };
  }

  if (question.length > POLL_MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      humanReason:
        `Discord caps a poll question at ${POLL_MAX_QUESTION_LENGTH} characters and yours is ` +
        `${question.length}. Cut ${question.length - POLL_MAX_QUESTION_LENGTH} of them.`,
    };
  }

  const answers = splitAnswers(input.answers);

  if (answers.length < POLL_MIN_ANSWERS) {
    return {
      ok: false,
      humanReason:
        `A poll needs at least ${POLL_MIN_ANSWERS} answers and I found ${answers.length} in ` +
        `that. ${SEPARATOR_HINT}`,
    };
  }

  if (answers.length > POLL_MAX_ANSWERS) {
    return {
      ok: false,
      humanReason:
        `Discord allows at most ${POLL_MAX_ANSWERS} answers on a poll and that is ` +
        `${answers.length}. Remove ${answers.length - POLL_MAX_ANSWERS} of them.`,
    };
  }

  const overlong = answers.findIndex((answer) => answer.length > POLL_MAX_ANSWER_LENGTH);
  if (overlong !== -1) {
    const answer = answers[overlong] as string;
    return {
      ok: false,
      humanReason:
        `Answer ${overlong + 1} is ${answer.length} characters and Discord caps a poll answer ` +
        `at ${POLL_MAX_ANSWER_LENGTH}. Cut ${answer.length - POLL_MAX_ANSWER_LENGTH} from ` +
        `“${answer.slice(0, POLL_MAX_ANSWER_LENGTH)}…”.`,
    };
  }

  if (!Number.isInteger(input.durationHours) || input.durationHours < POLL_MIN_DURATION_HOURS) {
    return {
      ok: false,
      humanReason:
        `A poll runs for whole hours, at least ${POLL_MIN_DURATION_HOURS} of them, and that ` +
        `asked for ${input.durationHours}.`,
    };
  }

  if (input.durationHours > POLL_MAX_DURATION_HOURS) {
    return {
      ok: false,
      humanReason:
        `Discord runs a poll for at most ${POLL_MAX_DURATION_HOURS} hours (32 days) and that ` +
        `asked for ${input.durationHours}.`,
    };
  }

  return {
    ok: true,
    poll: {
      question: { text: question },
      answers: answers.map((text) => ({ poll_media: { text } })),
      duration: input.durationHours,
      allow_multiselect: input.multiselect,
    },
  };
}

export function closesAt(startedAt: Date, durationHours: number): Date {
  return new Date(startedAt.getTime() + durationHours * 60 * 60 * 1000);
}
