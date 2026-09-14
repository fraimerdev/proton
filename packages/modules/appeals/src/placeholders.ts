import {
  type BuildEnv,
  buildTimeValues,
  collectConfigTemplates,
  DISCORD_TEXT_LIMITS,
  definePlaceholderSurface,
  isHttpUrl,
  lookupFrom,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type RenderResult,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_NOW,
  type TemplateFieldSpec,
  timeDefinitions,
  placeholderValue as v,
} from '@proton/core/placeholders';

export const APPEAL_DECISION_EVENT = 'appeals.decision';

export type AppealDecisionStatus = 'approved' | 'denied';

export interface AppealDecisionFacts {
  appeal: {
    number: number;
    status: AppealDecisionStatus;
    filedAt: number;
    decidedAt: number | null;
  };
  panel: { name: string; rejoinUrl?: string | undefined };
}

export type AppealDecisionField = 'discord_text' | 'plain_text';

const GROUP = 'Appeal';

const DAY = 24 * 60 * 60 * 1000;

const DATE_MS_MAX = 8_640_000_000_000_000;

const SAMPLE_REJOIN_URL = 'https://discord.gg/example';

const DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'appeal.number',
    label: 'Appeal number',
    description: 'The number the appeal was filed under',
    group: GROUP,
    type: 'integer',
    example: v.integer(7),
  },
  {
    key: 'appeal.status',
    label: 'Outcome',
    description: 'The decision as a word: approved or denied',
    group: GROUP,
    type: 'text',
    example: v.text('approved'),
  },
  {
    key: 'appeal.form_name',
    label: 'Form name',
    description: 'The name of the appeal form it was filed on',
    group: GROUP,
    type: 'text',
    example: v.text('Ban appeal'),
  },
  {
    key: 'appeal.filed_at',
    label: 'Filed',
    description: 'When the member sent the appeal',
    group: GROUP,
    type: 'datetime',
    example: v.datetime(SAMPLE_NOW - 2 * DAY),
  },
  {
    key: 'appeal.decided_at',
    label: 'Decided',
    description: 'When a moderator accepted or turned down the appeal',
    group: GROUP,
    type: 'datetime',
    example: v.datetime(SAMPLE_NOW),
  },
  {
    key: 'appeal.rejoin_url',
    label: 'Rejoin link',
    description: "The form's rejoin link. Empty when the form has none.",
    group: GROUP,
    type: 'url',
    example: v.url(SAMPLE_REJOIN_URL),
  },
  {
    key: 'appeal.decided_by',
    label: 'Decided by',
    description: 'The moderator who decided the appeal. Never shown to the member who appealed.',
    group: GROUP,
    type: 'mention',
    example: v.user('100000000000000030', 'A moderator'),
    sensitivity: 'staff_only',
  },
  {
    key: 'appeal.answer.<key>',
    label: 'Answer',
    description: 'An answer on the appeal, by question key. Only staff may see answers.',
    group: GROUP,
    type: 'text',
    example: v.text('I was hacked'),
    sensitivity: 'staff_only',
  },
  ...timeDefinitions(),
];

const FIELDS: readonly TemplateFieldSpec[] = [
  {
    path: 'panels.*.approvedMessage',
    kind: 'discord_text',
    label: 'Accepted message',
    limit: DISCORD_TEXT_LIMITS.content,
  },
  {
    path: 'panels.*.deniedMessage',
    kind: 'discord_text',
    label: 'Turned-down message',
    limit: DISCORD_TEXT_LIMITS.content,
  },
];

function moment(ms: number, what: string): ResolvedValue {
  return Number.isSafeInteger(ms) && Math.abs(ms) <= DATE_MS_MAX
    ? v.datetime(ms)
    : v.failed(`the time Proton holds for ${what} is not a whole number of milliseconds`);
}

function rejoinValue(url: string | undefined): ResolvedValue {
  if (url === undefined || url.trim() === '') return v.notSet('this form has no rejoin link');

  return isHttpUrl(url)
    ? v.url(url)
    : v.failed('the rejoin link on this form is not an http or https address');
}

function decisionLookup(facts: AppealDecisionFacts, env: BuildEnv): PlaceholderLookup {
  const { appeal, panel } = facts;

  return lookupFrom({
    'appeal.number': Number.isSafeInteger(appeal.number)
      ? v.integer(appeal.number)
      : v.failed('the number Proton holds for this appeal is not a whole number'),
    'appeal.status': v.text(appeal.status),
    'appeal.form_name': v.text(panel.name),
    'appeal.filed_at': moment(appeal.filedAt, 'when this appeal was filed'),
    'appeal.decided_at':
      appeal.decidedAt === null
        ? v.notSet('this appeal has not been decided')
        : moment(appeal.decidedAt, 'when this appeal was decided'),
    'appeal.rejoin_url': rejoinValue(panel.rejoinUrl),
    ...buildTimeValues(env.now),
  });
}

export const APPEAL_DECISION_SURFACE: PlaceholderSurface<AppealDecisionFacts> =
  definePlaceholderSurface<AppealDecisionFacts>({
    id: 'appeals.decision',
    module: 'appeals',
    label: 'Decision message',
    event: APPEAL_DECISION_EVENT,
    audience: 'member_private',
    fields: FIELDS,
    definitions: DEFINITIONS,
    build: decisionLookup,
    samples: [
      {
        id: 'member',
        label: 'Sample: appeal #7 on the Ban appeal form, accepted',
        facts: Object.freeze({
          appeal: Object.freeze({
            number: 7,
            status: 'approved' as const,
            filedAt: SAMPLE_NOW - 2 * DAY,
            decidedAt: SAMPLE_NOW,
          }),
          panel: Object.freeze({ name: 'Ban appeal', rejoinUrl: SAMPLE_REJOIN_URL }),
        }),
      },
    ],
  });

export const appealsTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze({ [APPEAL_DECISION_SURFACE.id]: APPEAL_DECISION_SURFACE }),
  collect: (config: unknown) => collectConfigTemplates(config, APPEAL_DECISION_SURFACE),
});

export function appealDecisionFacts(
  appeal: { number: number; status: string; filedAt: number; decidedAt: number | null },
  panel: { name: string; rejoinUrl?: string | undefined },
): AppealDecisionFacts {
  return {
    appeal: {
      number: appeal.number,
      status: appeal.status === 'approved' ? 'approved' : 'denied',
      filedAt: appeal.filedAt,
      decidedAt: appeal.decidedAt,
    },
    panel:
      panel.rejoinUrl === undefined
        ? { name: panel.name }
        : { name: panel.name, rejoinUrl: panel.rejoinUrl },
  };
}

export function renderAppealDecision(
  template: string,
  lookup: PlaceholderLookup,
  field: AppealDecisionField,
  now: number,
): RenderResult {
  return renderTemplate(template, lookup, {
    registry: APPEAL_DECISION_SURFACE.registry,
    field,
    event: APPEAL_DECISION_SURFACE.event,
    audience: APPEAL_DECISION_SURFACE.audience,
    now,
  });
}
