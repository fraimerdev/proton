import {
  type ApplicationLifecycle,
  type ApplicationStatus,
  applicationActionFailedSchema,
  applicationLifecycleSchema,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { type LogLine, logEmbed, userMention } from '../embed.ts';
import { actorLine } from './tickets.ts';
import type { RenderInput, RenderResult } from './types.ts';

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  needs_info: 'Needs information',
  waitlisted: 'Waitlisted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

const DECISION_COLOURS: Partial<Record<ApplicationStatus, number>> = {
  accepted: ServerLogColors.Add,
  rejected: ServerLogColors.Remove,
  waitlisted: ServerLogColors.Modify,
};

const EFFECT_LABELS: Record<string, string> = {
  card: 'Review card',
  ping: 'Reviewer ping',
  dm: 'DM to the applicant',
  add_role: 'Give a role',
  remove_role: 'Remove a role',
  xp: 'XP reward',
  ticket: 'Interview ticket',
  event: 'Event for other modules',
  reminder: 'Review reminder',
  delete_card: 'Remove the review card',
};

function referenceLines(payload: {
  number: number;
  formName: string;
  applicationId: string;
}): LogLine[] {
  return [
    { label: 'Application', value: `#${payload.number}` },
    { label: 'Form', value: payload.formName },
    { label: 'Application ID', value: payload.applicationId },
  ];
}

function applicantLine(applicantId: string): LogLine {
  return { label: 'Applicant', mention: userMention(applicantId), value: applicantId };
}

function reviewLines(input: RenderInput, applicationId: string): LogLine[] {
  if (!input.dashboardUrl) return [];

  const url = `${input.dashboardUrl.replace(/\/+$/, '')}/review/${input.guildId}/${applicationId}`;
  return [{ label: 'Review', mention: `[\`Open in Proton\`](${url})` }];
}

function lifecycleEmbed(
  input: RenderInput,
  payload: ApplicationLifecycle,
  action: string,
  colour: number,
  actor: LogLine[],
): RenderResult {
  return {
    embed: logEmbed({
      subject: `Application #${payload.number}`,
      action,
      colour,
      lines: [
        ...referenceLines(payload),
        applicantLine(payload.applicantId),
        { label: 'Status', value: STATUS_LABELS[payload.status] },
        ...actor,
        ...reviewLines(input, payload.applicationId),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderApplicationSubmitted(input: RenderInput): RenderResult | null {
  const parsed = applicationLifecycleSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  return lifecycleEmbed(input, parsed.data, 'submitted', ServerLogColors.Add, []);
}

export function renderApplicationDecided(input: RenderInput): RenderResult | null {
  const parsed = applicationLifecycleSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  const colour = DECISION_COLOURS[payload.status];
  if (colour === undefined) return null;

  return lifecycleEmbed(input, payload, payload.status, colour, [
    actorLine('Decided by', payload.actorId),
  ]);
}

export function renderApplicationReopened(input: RenderInput): RenderResult | null {
  const parsed = applicationLifecycleSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return lifecycleEmbed(input, payload, 'reopened', ServerLogColors.Add, [
    actorLine('Reopened by', payload.actorId),
  ]);
}

export function renderApplicationActionFailed(input: RenderInput): RenderResult | null {
  const parsed = applicationActionFailedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Application #${payload.number}`,
      action: 'action failed',
      colour: ServerLogColors.Remove,
      lines: [
        ...referenceLines(payload),
        {
          label: 'Action',
          value: EFFECT_LABELS[payload.kind] ?? payload.kind.replaceAll('_', ' '),
        },
        { label: 'Error', value: payload.errorCode },
        ...reviewLines(input, payload.applicationId),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
