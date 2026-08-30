import { z } from 'zod';
import { ANSWER_MAX, type AppealPanel, type AppealsConfig, panelFor } from './config.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export const APPEAL_STATES = ['open', 'filed', 'decided', 'closed'] as const;
export type AppealState = (typeof APPEAL_STATES)[number];

export interface FiledAppeal {
  id: string;
  number: number;
  status: 'open' | 'approved' | 'denied';
  filedAt: number;
  decidedAt: number | null;
}

export interface AppealViewInput {
  config: AppealsConfig;
  panelId: string;

  issuedAt: number;
  now: number;

  existing?: FiledAppeal | undefined;

  // The most recent decided appeal by this member in this guild, whatever link produced it.
  lastDecidedAt?: number | undefined;
}

export type AppealView =
  | { state: 'open'; panel: AppealPanel }
  | { state: 'filed'; panel: AppealPanel; appeal: FiledAppeal; humanReason: string }
  | {
      state: 'decided';
      panel: AppealPanel;
      appeal: FiledAppeal;
      humanReason: string;
      resubmit: boolean;
    }
  | { state: 'closed'; humanReason: string };

/**
 * The one answer to "is this link still good?", shared by the page that renders the form and the
 * route that accepts it — a form that renders and then refuses on submit is a form that wasted
 * somebody's only appeal.
 */
export function appealView(input: AppealViewInput): AppealView {
  const { config, panelId, existing, issuedAt, now } = input;

  const panel = panelFor(config, panelId);

  // An appeal already filed under this link outranks every closed reason below. The same link is
  // how a banned member is told what came of it, and a disabled form or an elapsed window must not
  // take that away from somebody who already used it in time.
  if (existing) {
    if (!panel) {
      return {
        state: 'closed',
        humanReason:
          'This appeal was filed, but the form it belonged to has since been removed. A ' +
          'moderator can still see it.',
      };
    }

    if (existing.status === 'open') {
      return {
        state: 'filed',
        panel,
        appeal: existing,
        humanReason:
          'Your appeal has been sent to the moderators. Nothing more is needed from you.',
      };
    }

    const resubmit =
      panel.allowResubmit &&
      existing.status === 'denied' &&
      now - (existing.decidedAt ?? existing.filedAt) >= panel.cooldownDays * DAY_MS;

    return {
      state: 'decided',
      panel,
      appeal: existing,
      resubmit,
      humanReason:
        existing.status === 'approved'
          ? panel.approvedMessage
          : resubmit
            ? `${panel.deniedMessage} You may send another one now.`
            : panel.deniedMessage,
    };
  }

  if (!config.enabled) {
    return { state: 'closed', humanReason: 'This server is not taking appeals at the moment.' };
  }

  if (!panel) {
    return {
      state: 'closed',
      humanReason:
        'The appeal form this link points at no longer exists. Nothing you did caused this — ' +
        'the server changed its settings.',
    };
  }

  if (!panel.enabled) {
    return { state: 'closed', humanReason: 'This server is not taking appeals at the moment.' };
  }

  if (now - issuedAt >= panel.windowDays * DAY_MS) {
    return {
      state: 'closed',
      humanReason: `Appeals close ${panel.windowDays} days after the action, and that has passed.`,
    };
  }

  if (
    input.lastDecidedAt !== undefined &&
    now - input.lastDecidedAt < panel.cooldownDays * DAY_MS
  ) {
    const days = Math.ceil((panel.cooldownDays * DAY_MS - (now - input.lastDecidedAt)) / DAY_MS);

    return {
      state: 'closed',
      humanReason: `You appealed recently. You can appeal again in ${days} days.`,
    };
  }

  return { state: 'open', panel };
}

export const appealAnswersSchema = z.record(z.string(), z.string());

export type AppealAnswers = z.infer<typeof appealAnswersSchema>;

export interface CheckedAnswer {
  key: string;
  label: string;
  value: string;
}

export type AnswerCheck =
  | { ok: true; answers: CheckedAnswer[] }
  | { ok: false; humanReason: string };

/**
 * Labels are rebuilt from the panel and question ids the panel does not carry are dropped, so what
 * a moderator reads is what the server asked, never what the browser sent.
 */
export function checkAnswers(panel: AppealPanel, raw: AppealAnswers): AnswerCheck {
  const answers: CheckedAnswer[] = [];

  for (const question of panel.questions) {
    const value = (raw[question.key] ?? '').trim();

    if (value === '') {
      if (question.required) {
        return { ok: false, humanReason: `“${question.label}” needs an answer.` };
      }
      continue;
    }

    answers.push({
      key: question.key,
      label: question.label,
      value: value.slice(0, Math.min(question.maxLength, ANSWER_MAX)),
    });
  }

  if (answers.length === 0) {
    return { ok: false, humanReason: 'An appeal needs at least one answer.' };
  }

  return { ok: true, answers };
}
