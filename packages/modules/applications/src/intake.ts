import type { ServerFacts } from '@proton/core/placeholders';
import { z } from 'zod';
import { type ApplicationsConfig, type FormConfig, reviewChannelFor } from './config.ts';
import { renderClosedMessage } from './placeholders.ts';
import { dayCount } from './web.ts';

export const INTAKE_CLOSED_REASONS = [
  'not_published',
  'closed',
  'not_yet_open',
  'deadline_passed',
  'full',
  'archived',
  'module_off',
] as const;
export type IntakeClosedReason = (typeof INTAKE_CLOSED_REASONS)[number];

export const intakeStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), closesAt: z.number().int().optional() }),
  z.object({
    state: z.literal('closed'),
    reason: z.enum(INTAKE_CLOSED_REASONS),
    opensAt: z.number().int().optional(),
    closesAt: z.number().int().optional(),
  }),
]);
export type IntakeState = z.infer<typeof intakeStateSchema>;

type IntakeForm = Pick<FormConfig, 'intake' | 'archived'>;

function closed(
  reason: IntakeClosedReason,
  intake: FormConfig['intake'],
  times: { opensAt?: boolean; closesAt?: boolean } = {},
): IntakeState {
  return {
    state: 'closed',
    reason,
    ...(times.opensAt && intake.opensAt !== undefined ? { opensAt: intake.opensAt } : {}),
    ...(times.closesAt && intake.closesAt !== undefined ? { closesAt: intake.closesAt } : {}),
  };
}

export function intakeState(input: {
  moduleOn: boolean;
  form: IntakeForm;
  published: boolean;
  submittedCount?: number | undefined;
  now: number;
}): IntakeState {
  const { form, now } = input;
  const { intake } = form;

  if (!input.moduleOn) return closed('module_off', intake);
  if (form.archived) return closed('archived', intake);
  if (!input.published) return closed('not_published', intake);
  if (!intake.open) return closed('closed', intake);

  if (intake.opensAt !== undefined && now < intake.opensAt) {
    return closed('not_yet_open', intake, { opensAt: true, closesAt: true });
  }
  if (intake.closesAt !== undefined && now >= intake.closesAt) {
    return closed('deadline_passed', intake, { closesAt: true });
  }
  if (
    intake.cap !== undefined &&
    input.submittedCount !== undefined &&
    input.submittedCount >= intake.cap
  ) {
    return closed('full', intake);
  }

  return intake.closesAt === undefined
    ? { state: 'open' }
    : { state: 'open', closesAt: intake.closesAt };
}

export type SentenceField = 'discord_text' | 'plain_text';

const PLAIN_DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function when(ms: number, field: SentenceField): string {
  if (field === 'discord_text') {
    const seconds = Math.floor(ms / 1000);
    return `<t:${seconds}:f> (<t:${seconds}:R>)`;
  }
  return `${PLAIN_DATE.format(ms)} UTC`;
}

export function intakeSentence(
  state: IntakeState,
  form: Pick<FormConfig, 'name' | 'messages'>,
  options: { field?: SentenceField; server?: ServerFacts | null; now?: number } = {},
): string {
  const field = options.field ?? 'plain_text';

  if (state.state === 'open') {
    return state.closesAt === undefined
      ? 'This form is open for applications.'
      : `This form is open for applications until ${when(state.closesAt, field)}.`;
  }

  switch (state.reason) {
    case 'module_off':
      return 'Applications are off in this server right now.';
    case 'archived':
      return 'This form is no longer taking applications.';
    case 'not_published':
      return 'This form isn’t open yet.';
    case 'closed': {
      const rendered = renderClosedMessage(
        form.messages.closed,
        { formName: form.name, server: options.server ?? null },
        { now: options.now ?? Date.now(), field },
      ).output.trim();
      return rendered === '' ? 'This form isn’t taking applications right now.' : rendered;
    }
    case 'not_yet_open':
      return state.opensAt === undefined
        ? 'This form isn’t open yet.'
        : `This form opens for applications on ${when(state.opensAt, field)}.`;
    case 'deadline_passed':
      return state.closesAt === undefined
        ? 'The deadline for this form has passed.'
        : `The deadline for this form passed on ${when(state.closesAt, field)}.`;
    case 'full':
      return 'This form has received as many applications as it can take.';
  }
}

export function whoCanRead(
  config: Pick<ApplicationsConfig, 'reviewChannelId'>,
  form: Pick<FormConfig, 'review'>,
  retentionDays: number,
): string {
  const posted = reviewChannelFor(config, form) !== undefined;
  const mode = form.review.cardAnswers;

  const who =
    !posted || mode === 'none'
      ? 'Staff who review this form can read your answers.'
      : mode === 'summary'
        ? 'Staff who review this form can read your answers. A short summary is posted in a staff channel, and anyone who can read that channel can see it.'
        : 'Staff who review this form can read your answers. They’re also posted in a staff channel, and anyone who can read that channel can see them.';

  return `${who} Proton keeps them for ${dayCount(retentionDays)} after a decision.`;
}
