import {
  type BuildEnv,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  collectConfigTemplates,
  collectMessageSites,
  definePlaceholderSurface,
  isHttpUrl,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MessageRender,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type ProtonMessageLike,
  type RenderResult,
  type ResolvedValue,
  renderMessageTemplate,
  renderTemplate,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type ServerFacts,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
  withAvailability,
} from '@proton/core/placeholders';
import { MODULE_ID } from './constants.ts';
import { referenceOf } from './web.ts';

export const RECEIPT_EVENT = 'applications.receipt';
export const DECISION_EVENT = 'applications.decision';
export const INFO_REQUEST_EVENT = 'applications.info_request';
export const WITHDRAWN_EVENT = 'applications.withdrawn';
export const CLOSED_EVENT = 'applications.closed';

export interface ApplicantMessageFacts {
  user: UserFacts | null;
  server: ServerFacts | null;
  moderator: UserFacts | null;
  application: {
    number: number;
    formName: string;
    statusLabel: string;
    submittedAt: number;
    reviewedAt: number | null;
    reason: string | null;
    request: string | null;
    url: string | null;
  };
}

export interface ClosedMessageFacts {
  formName: string;
  server: ServerFacts | null;
}

const GROUP = 'Application';
const DAY = 24 * 60 * 60 * 1000;
const DATE_MS_MAX = 8_640_000_000_000_000;
const STAFF_ONLY = 'only staff can see this';

const SENT = [RECEIPT_EVENT, DECISION_EVENT, INFO_REQUEST_EVENT, WITHDRAWN_EVENT];

const SAMPLE_URL = `https://prtn.xyz/applications/${SAMPLE_SERVER.id}/01JAPPLICATIONSAMPLE0000000`;

const SAMPLE_MODERATOR: UserFacts = Object.freeze({
  id: '100000000000000030',
  username: 'kestrel',
  globalName: 'Kestrel',
  avatarHash: null,
});

const APPLICATION_KEYS: readonly PlaceholderDefinitionInput[] = [
  withAvailability(
    {
      key: 'application.id',
      label: 'Reference',
      description: 'The application’s reference, like #12',
      group: GROUP,
      keywords: ['reference', 'number'],
      type: 'text',
      example: v.text('#12'),
    },
    SENT,
  ),
  withAvailability(
    {
      key: 'application.number',
      label: 'Number',
      description: 'The application’s number in this server, like 12',
      group: GROUP,
      type: 'integer',
      example: v.integer(12),
    },
    SENT,
  ),
  {
    key: 'application.name',
    label: 'Form name',
    description: 'The name of the form, like Moderator Application',
    group: GROUP,
    keywords: ['form'],
    type: 'text',
    example: v.text('Moderator Application'),
  },
  withAvailability(
    {
      key: 'application.status',
      label: 'Status',
      description: 'Where the application stands, like In review or Accepted',
      group: GROUP,
      type: 'text',
      example: v.text('Accepted'),
    },
    SENT,
  ),
  withAvailability(
    {
      key: 'application.submitted_at',
      label: 'Sent',
      description: 'When the application was sent',
      group: GROUP,
      keywords: ['submitted', 'date'],
      type: 'datetime',
      example: v.datetime(SAMPLE_NOW - 2 * DAY),
    },
    SENT,
  ),
  withAvailability(
    {
      key: 'application.reviewed_at',
      label: 'Decided',
      description: 'When staff made the decision',
      group: GROUP,
      keywords: ['reviewed', 'date'],
      type: 'datetime',
      example: v.datetime(SAMPLE_NOW),
    },
    [DECISION_EVENT],
  ),
  withAvailability(
    {
      key: 'application.reason',
      label: 'Reason',
      description: 'The reason staff wrote for the applicant. Empty when they wrote none.',
      group: GROUP,
      keywords: ['note', 'decision'],
      type: 'text',
      example: v.text('Thanks for the thoughtful answers.'),
    },
    [DECISION_EVENT],
  ),
  withAvailability(
    {
      key: 'application.request',
      label: 'Question from staff',
      description: 'What staff asked the applicant',
      group: GROUP,
      keywords: ['question', 'information'],
      type: 'text',
      example: v.text('Could you share a project you’ve worked on?'),
    },
    [INFO_REQUEST_EVENT],
  ),
  withAvailability(
    {
      key: 'application.url',
      label: 'Status page link',
      description: 'A link to the application’s status page on the web',
      group: GROUP,
      keywords: ['link', 'web'],
      type: 'url',
      example: v.url(SAMPLE_URL),
    },
    SENT,
  ),
];

const STAFF_ONLY_KEYS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'application.internal_note',
    label: 'Internal note',
    description: 'A private note from the review team. Never sent to applicants.',
    group: GROUP,
    type: 'text',
    example: v.text('Strong answers on the scenarios.'),
    sensitivity: 'staff_only',
  },
  {
    key: 'application.votes',
    label: 'Votes',
    description: 'How reviewers voted. Staff only.',
    group: GROUP,
    type: 'text',
    example: v.text('2 accept, 1 reject'),
    sensitivity: 'staff_only',
  },
  {
    key: 'application.score',
    label: 'Score',
    description: 'The average review score. Staff only.',
    group: GROUP,
    type: 'number',
    example: v.number(4.5),
    sensitivity: 'staff_only',
  },
];

function definitionsFor(options: {
  moderator: boolean;
  user: boolean;
}): PlaceholderDefinitionInput[] {
  return [
    ...APPLICATION_KEYS,
    ...STAFF_ONLY_KEYS,
    ...(options.user ? userDefinitions('user', { member: false }) : []),
    ...(options.moderator ? userDefinitions('moderator', { member: false }) : []),
    ...serverDefinitions(),
    ...timeDefinitions(),
  ];
}

function messageFields(...bases: string[]): TemplateFieldSpec[] {
  return bases.flatMap((base) =>
    MESSAGE_TEMPLATE_FIELDS.map((spec) => ({ ...spec, path: `${base}.${spec.path}` })),
  );
}

function moment(ms: number | null, what: string, unset: string): ResolvedValue {
  if (ms === null) return v.notSet(unset);
  return Number.isSafeInteger(ms) && Math.abs(ms) <= DATE_MS_MAX
    ? v.datetime(ms)
    : v.failed(`the time Proton holds for ${what} is not a whole number of milliseconds`);
}

function textOrUnset(value: string | null, reason: string): ResolvedValue {
  return value === null || value.trim() === '' ? v.notSet(reason) : v.text(value);
}

function urlValue(url: string | null): ResolvedValue {
  if (url === null || url.trim() === '') return v.notSet('there is no status page link here');
  return isHttpUrl(url) ? v.url(url) : v.failed('the status page link is not an http address');
}

const RESTRICTED = Object.fromEntries(
  STAFF_ONLY_KEYS.map(({ key }) => [key, v.restricted(STAFF_ONLY)] as const),
);

function applicantLookup(facts: ApplicantMessageFacts, env: BuildEnv): PlaceholderLookup {
  const { application } = facts;
  const counted = Number.isSafeInteger(application.number) && application.number > 0;

  return lookupFrom({
    'application.id': counted
      ? v.text(referenceOf(application.number))
      : v.failed('the number Proton holds for this application is not a whole number'),
    'application.number': counted
      ? v.integer(application.number)
      : v.failed('the number Proton holds for this application is not a whole number'),
    'application.name': v.text(application.formName),
    'application.status': v.text(application.statusLabel),
    'application.submitted_at': moment(
      application.submittedAt,
      'when this application was sent',
      'this application has not been sent',
    ),
    'application.reviewed_at': moment(
      application.reviewedAt,
      'when this application was decided',
      'this application has not been decided',
    ),
    'application.reason': textOrUnset(application.reason, 'staff wrote no reason'),
    'application.request': textOrUnset(application.request, 'staff have not asked anything'),
    'application.url': urlValue(application.url),
    ...RESTRICTED,
    ...buildUserValues('user', facts.user, null, env.now),
    ...buildUserValues('moderator', facts.moderator, null, env.now),
    ...buildServerValues(facts.server),
    ...buildTimeValues(env.now),
  });
}

function closedLookup(facts: ClosedMessageFacts, env: BuildEnv): PlaceholderLookup {
  return lookupFrom({
    'application.name': v.text(facts.formName),
    ...RESTRICTED,
    ...buildServerValues(facts.server),
    ...buildTimeValues(env.now),
  });
}

function sample(
  extra: Partial<ApplicantMessageFacts['application']>,
  moderator: UserFacts | null = null,
): ApplicantMessageFacts {
  return Object.freeze({
    user: SAMPLE_MEMBER.user,
    server: SAMPLE_SERVER,
    moderator,
    application: Object.freeze({
      number: 12,
      formName: 'Moderator Application',
      statusLabel: 'Submitted',
      submittedAt: SAMPLE_NOW - 2 * DAY,
      reviewedAt: null,
      reason: null,
      request: null,
      url: SAMPLE_URL,
      ...extra,
    }),
  });
}

const APPLICANT = SAMPLE_MEMBER.user.globalName ?? 'A member';

export const RECEIPT_SURFACE: PlaceholderSurface<ApplicantMessageFacts> =
  definePlaceholderSurface<ApplicantMessageFacts>({
    id: RECEIPT_EVENT,
    module: MODULE_ID,
    label: 'Application sent message',
    event: RECEIPT_EVENT,
    audience: 'member_private',
    fields: messageFields('forms.*.messages.receipt'),
    definitions: definitionsFor({ user: true, moderator: false }),
    build: applicantLookup,
    samples: [
      {
        id: 'member',
        label: `Sample: ${APPLICANT} sends application #12 on the Moderator Application form`,
        facts: sample({}),
      },
    ],
  });

export const DECISION_SURFACE: PlaceholderSurface<ApplicantMessageFacts> =
  definePlaceholderSurface<ApplicantMessageFacts>({
    id: DECISION_EVENT,
    module: MODULE_ID,
    label: 'Decision message',
    event: DECISION_EVENT,
    audience: 'member_private',
    fields: messageFields(
      'forms.*.messages.accepted',
      'forms.*.messages.rejected',
      'forms.*.messages.waitlisted',
    ),
    definitions: definitionsFor({ user: true, moderator: true }),
    build: applicantLookup,
    samples: [
      {
        id: 'member',
        label: `Sample: staff accept ${APPLICANT}’s application #12`,
        facts: sample(
          {
            statusLabel: 'Accepted',
            reviewedAt: SAMPLE_NOW,
            reason: 'Thanks for the thoughtful answers. Someone from the team will reach out.',
          },
          SAMPLE_MODERATOR,
        ),
      },
    ],
  });

export const INFO_REQUEST_SURFACE: PlaceholderSurface<ApplicantMessageFacts> =
  definePlaceholderSurface<ApplicantMessageFacts>({
    id: INFO_REQUEST_EVENT,
    module: MODULE_ID,
    label: 'Information request message',
    event: INFO_REQUEST_EVENT,
    audience: 'member_private',
    fields: messageFields('forms.*.messages.infoRequest'),
    definitions: definitionsFor({ user: true, moderator: false }),
    build: applicantLookup,
    samples: [
      {
        id: 'member',
        label: `Sample: staff ask ${APPLICANT} a question about application #12`,
        facts: sample({
          statusLabel: 'Needs information',
          request: 'Could you share a link to a community you’ve moderated before?',
        }),
      },
    ],
  });

export const WITHDRAWN_SURFACE: PlaceholderSurface<ApplicantMessageFacts> =
  definePlaceholderSurface<ApplicantMessageFacts>({
    id: WITHDRAWN_EVENT,
    module: MODULE_ID,
    label: 'Application withdrawn message',
    event: WITHDRAWN_EVENT,
    audience: 'member_private',
    fields: messageFields('forms.*.messages.withdrawn'),
    definitions: definitionsFor({ user: true, moderator: false }),
    build: applicantLookup,
    samples: [
      {
        id: 'member',
        label: `Sample: ${APPLICANT} withdraws application #12`,
        facts: sample({ statusLabel: 'Withdrawn' }),
      },
    ],
  });

export const CLOSED_SURFACE: PlaceholderSurface<ClosedMessageFacts> =
  definePlaceholderSurface<ClosedMessageFacts>({
    id: CLOSED_EVENT,
    module: MODULE_ID,
    label: 'Form closed message',
    event: CLOSED_EVENT,
    audience: 'member_private',
    fields: [
      {
        path: 'forms.*.messages.closed',
        kind: 'discord_text',
        label: 'Closed message',
        limit: 1000,
      },
    ],
    definitions: definitionsFor({ user: false, moderator: false }),
    build: closedLookup,
    samples: [
      {
        id: 'member',
        label: 'Sample: the Moderator Application form is closed',
        facts: Object.freeze({ formName: 'Moderator Application', server: SAMPLE_SERVER }),
      },
    ],
  });

export const APPLICANT_SURFACES = {
  receipt: RECEIPT_SURFACE,
  accepted: DECISION_SURFACE,
  rejected: DECISION_SURFACE,
  waitlisted: DECISION_SURFACE,
  infoRequest: INFO_REQUEST_SURFACE,
  withdrawn: WITHDRAWN_SURFACE,
} as const;

const SURFACES: readonly PlaceholderSurface<unknown>[] = [
  RECEIPT_SURFACE,
  DECISION_SURFACE,
  INFO_REQUEST_SURFACE,
  WITHDRAWN_SURFACE,
  CLOSED_SURFACE,
];

export const applicationsTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze(Object.fromEntries(SURFACES.map((surface) => [surface.id, surface]))),
  collect: (config: unknown) =>
    SURFACES.flatMap((surface) => collectConfigTemplates(config, surface)),
});

export function renderApplicantMessage<M extends ProtonMessageLike>(
  surface: PlaceholderSurface<ApplicantMessageFacts>,
  message: M,
  facts: ApplicantMessageFacts,
  options: { now: number; basePath?: string | undefined },
): MessageRender<M> {
  const keys = usedKeys(
    surface,
    collectMessageSites(message, '').map(({ text }) => text),
    { allowedOnly: true },
  );

  return renderMessageTemplate(message, surface, surface.build(facts, { now: options.now, keys }), {
    now: options.now,
    basePath: options.basePath,
  });
}

export function renderClosedMessage(
  template: string,
  facts: ClosedMessageFacts,
  options: { now: number; field: 'discord_text' | 'plain_text' },
): RenderResult {
  return renderTemplate(template, CLOSED_SURFACE.build(facts, { now: options.now }), {
    registry: CLOSED_SURFACE.registry,
    field: options.field,
    event: CLOSED_SURFACE.event,
    audience: CLOSED_SURFACE.audience,
    now: options.now,
  });
}
