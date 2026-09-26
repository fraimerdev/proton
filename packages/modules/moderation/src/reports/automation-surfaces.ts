import {
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  collectConfigTemplates,
  collectMessageSites,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MessageRender,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type ResolvedValue,
  renderMessageTemplate,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type ServerFacts,
  serverDefinitions,
  type TemplateFieldSpec,
  type TemplateSite,
  timeDefinitions,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
} from '@proton/core/placeholders';
import type { DmMessage } from '../punish/config.ts';
import type { StaffMessage } from './config.ts';
import { REPORT_METHOD_NAMES, REPORT_STATUS_NAMES } from './surfaces.ts';
import type { ReportMethod, ReportStatus } from './types.ts';

export const REPORT_ALERT_EVENT = 'moderation.report_alert';
export const REPORT_MEMBER_NOTICE_EVENT = 'moderation.report_member_notice';

export interface AlertReportFacts {
  id: string;
  number: number;
  status: ReportStatus;
  method: ReportMethod;
  methodName?: string;
  reason: string | null;
  createdAt: number;
  messageUrl: string | null;
  url: string | null;
}

export interface ReportAlertFacts {
  ruleName: string;
  report: AlertReportFacts | null;
  totalReports: number;
  reporterCount: number;
  target: UserFacts | null;
  server: ServerFacts | null;
  bot: BotFacts | null;
}

export interface MemberNoticeFacts {
  ruleName: string;
  user: UserFacts | null;
  server: ServerFacts | null;
  bot: BotFacts | null;
}

export function reportDashboardUrl(
  dashboardUrl: string | undefined,
  guildId: string,
  reportId: string,
): string | null {
  const base = dashboardUrl?.trim().replace(/\/+$/, '') ?? '';
  if (base === '') return null;

  return `${base}/dashboard/${guildId}/moderation?area=reports-queue&id=${encodeURIComponent(reportId)}`;
}

const REPORT_GROUP = 'Report';
const HOUR = 3_600_000;

const SAMPLE_REPORT_ID = 'Rk3P9aQ';
const SAMPLE_MESSAGE_URL = `https://discord.com/channels/${SAMPLE_SERVER.id}/100000000000000040/100000000000000041`;
const SAMPLE_RULE = 'Several members report the same person';

const RULE_NAME: PlaceholderDefinitionInput = {
  key: 'rule.name',
  label: 'Rule name',
  description: 'The name of the automation rule that sent this',
  group: 'Rule',
  type: 'text',
  example: v.text(SAMPLE_RULE),
};

const ALERT_REPORT_KEYS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'report.id',
    label: 'Latest report ID',
    description: 'The ID of the newest report that set off the rule, like Rk3P9aQ',
    group: REPORT_GROUP,
    type: 'text',
    example: v.text(SAMPLE_REPORT_ID),
  },
  {
    key: 'report.number',
    label: 'Latest report number',
    description: 'Its number in this server’s queue',
    group: REPORT_GROUP,
    type: 'integer',
    example: v.integer(42),
  },
  {
    key: 'report.status',
    label: 'Latest report status',
    description: 'Where it stands: open, in review, accepted or dismissed',
    group: REPORT_GROUP,
    type: 'text',
    example: v.text('open'),
  },
  {
    key: 'report.method',
    label: 'Filed with',
    description: 'How the newest report was filed, like /report or Report message',
    group: REPORT_GROUP,
    type: 'text',
    example: v.text('Report message'),
  },
  {
    key: 'report.reason',
    label: 'Latest reason',
    description: 'The reason picked from the server’s list. Empty when none was picked.',
    group: REPORT_GROUP,
    type: 'text',
    example: v.text('Spam or flooding'),
  },
  {
    key: 'report.created_at',
    label: 'Latest report filed',
    description: 'When the newest report was filed',
    group: REPORT_GROUP,
    type: 'datetime',
    example: v.datetime(SAMPLE_NOW - HOUR),
  },
  {
    key: 'report.message_url',
    label: 'Reported message link',
    description: 'A link to the message the newest report is about. Empty for a member report.',
    group: REPORT_GROUP,
    type: 'url',
    example: v.url(SAMPLE_MESSAGE_URL),
  },
  {
    key: 'report.url',
    label: 'Dashboard link',
    description: 'A link to the newest report in the Proton dashboard',
    group: REPORT_GROUP,
    type: 'url',
    example: v.url('https://prtn.xyz/dashboard'),
  },
  {
    key: 'report.total_reports',
    label: 'Reports',
    description: 'How many reports set off the rule',
    group: REPORT_GROUP,
    type: 'integer',
    example: v.integer(4),
  },
  {
    key: 'report.reporter_count',
    label: 'Different reporters',
    description: 'How many different members filed them',
    group: REPORT_GROUP,
    type: 'integer',
    example: v.integer(3),
  },
];

const HIDDEN_REPORT_KEYS: readonly PlaceholderDefinitionInput[] = [
  ...ALERT_REPORT_KEYS,
  ...(
    [
      ['report.custom_reason', 'Own reason'],
      ['report.comment', 'Details'],
      ['report.action', 'Action taken'],
      ['report.explanation', 'Note from staff'],
      ['report.internal_note', 'Internal note'],
      ['report.case_ids', 'Case IDs'],
    ] as const
  ).map(
    ([key, label]): PlaceholderDefinitionInput => ({
      key,
      label,
      description: 'Part of a report.',
      group: REPORT_GROUP,
      type: 'text',
      example: v.text('Hidden'),
    }),
  ),
];

const NEVER_TOLD =
  'Staff only. The reported member is never told who reported them or what the reports say.';

function staffOnly(definition: PlaceholderDefinitionInput): PlaceholderDefinitionInput {
  return { ...definition, description: NEVER_TOLD, sensitivity: 'staff_only' };
}

function messageFields(): TemplateFieldSpec[] {
  return MESSAGE_TEMPLATE_FIELDS.map((spec) => ({
    ...spec,
    path: `reports.automation.*.actions.*.message.${spec.path}`,
  }));
}

function textOrUnset(value: string | null, reason: string): ResolvedValue {
  return value === null || value.trim() === '' ? v.notSet(reason) : v.text(value);
}

function reportValues(report: AlertReportFacts | null): Record<string, ResolvedValue> {
  if (report === null) {
    const missing = v.unavailable('Proton couldn’t read the newest report');
    return Object.fromEntries(
      ALERT_REPORT_KEYS.filter(
        ({ key }) => key !== 'report.total_reports' && key !== 'report.reporter_count',
      ).map(({ key }) => [key, missing]),
    );
  }

  return {
    'report.id': v.text(report.id),
    'report.number': v.integer(report.number),
    'report.status': v.text(REPORT_STATUS_NAMES[report.status]),
    'report.method': v.text(report.methodName ?? REPORT_METHOD_NAMES[report.method]),
    'report.reason': textOrUnset(report.reason, 'no reason was picked'),
    'report.created_at': v.datetime(report.createdAt),
    'report.message_url':
      report.messageUrl === null
        ? v.notSet('the report is about a member, not a message')
        : v.url(report.messageUrl),
    'report.url':
      report.url === null
        ? v.unavailable('Proton doesn’t know where the dashboard is')
        : v.url(report.url),
  };
}

function alertLookup(facts: ReportAlertFacts, env: BuildEnv): PlaceholderLookup {
  return lookupFrom({
    'rule.name': v.text(facts.ruleName),
    ...reportValues(facts.report),
    'report.total_reports': v.integer(facts.totalReports),
    'report.reporter_count': v.integer(facts.reporterCount),
    ...buildUserValues('target', facts.target, null, env.now),
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
  });
}

const TARGET_DEFINITIONS = userDefinitions('target', { member: false });

const RESTRICTED = v.restricted('only staff can see this');

function noticeLookup(facts: MemberNoticeFacts, env: BuildEnv): PlaceholderLookup {
  return lookupFrom({
    'rule.name': v.text(facts.ruleName),
    ...Object.fromEntries(
      [...HIDDEN_REPORT_KEYS, ...TARGET_DEFINITIONS].map(({ key }) => [key, RESTRICTED]),
    ),
    ...buildUserValues('user', facts.user, null, env.now),
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
  });
}

const SAMPLE_ALERT: ReportAlertFacts = Object.freeze({
  ruleName: SAMPLE_RULE,
  report: Object.freeze({
    id: SAMPLE_REPORT_ID,
    number: 42,
    status: 'open' as const,
    method: 'message_menu' as const,
    reason: 'Spam or flooding',
    createdAt: SAMPLE_NOW - HOUR,
    messageUrl: SAMPLE_MESSAGE_URL,
    url: 'https://prtn.xyz/dashboard',
  }),
  totalReports: 4,
  reporterCount: 3,
  target: SAMPLE_MEMBER.user,
  server: SAMPLE_SERVER,
  bot: SAMPLE_BOT,
});

const TARGET_NAME = SAMPLE_MEMBER.user.globalName ?? 'a member';

export const REPORT_ALERT_SURFACE: PlaceholderSurface<ReportAlertFacts> =
  definePlaceholderSurface<ReportAlertFacts>({
    id: 'moderation.report_alert',
    module: 'moderation',
    label: 'Report automation alert',
    event: REPORT_ALERT_EVENT,
    audience: 'staff_only',
    fields: messageFields(),
    definitions: [
      RULE_NAME,
      ...ALERT_REPORT_KEYS,
      ...TARGET_DEFINITIONS,
      ...serverDefinitions(),
      ...botDefinitions(),
      ...timeDefinitions(),
    ],
    build: alertLookup,
    samples: [
      {
        id: 'report',
        label: `Sample: three members report ${TARGET_NAME} within a day`,
        facts: SAMPLE_ALERT,
      },
    ],
  });

export const REPORT_MEMBER_NOTICE_SURFACE: PlaceholderSurface<MemberNoticeFacts> =
  definePlaceholderSurface<MemberNoticeFacts>({
    id: 'moderation.report_member_notice',
    module: 'moderation',
    label: 'Report automation message to the reported member',
    event: REPORT_MEMBER_NOTICE_EVENT,
    audience: 'member_private',
    fields: messageFields(),
    definitions: [
      RULE_NAME,
      ...HIDDEN_REPORT_KEYS.map(staffOnly),
      ...TARGET_DEFINITIONS.map(staffOnly),
      ...userDefinitions('user', { member: false }),
      ...serverDefinitions(),
      ...botDefinitions(),
      ...timeDefinitions(),
    ],
    build: noticeLookup,
    samples: [
      {
        id: 'report',
        label: `Sample: a rule messages ${TARGET_NAME} after several reports`,
        facts: Object.freeze({
          ruleName: SAMPLE_RULE,
          user: SAMPLE_MEMBER.user,
          server: SAMPLE_SERVER,
          bot: SAMPLE_BOT,
        }),
      },
    ],
  });

export const AUTOMATION_SURFACES: readonly PlaceholderSurface<unknown>[] = [
  REPORT_ALERT_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
];

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function own(value: Record<string, unknown> | null, key: string): unknown {
  return value !== null && Object.hasOwn(value, key) ? value[key] : undefined;
}

// One path pattern serves both surfaces; masking by kind stops each validating the other's text.
function actionsOfKind(config: unknown, kind: 'alert' | 'dm'): unknown {
  const rules = own(recordOf(own(recordOf(config), 'reports')), 'automation');
  if (!Array.isArray(rules)) return {};

  const masked: unknown[] = rules.map((rule: unknown) => {
    const actions = own(recordOf(rule), 'actions');
    if (!Array.isArray(actions)) return undefined;

    return {
      actions: actions.map((action: unknown) =>
        own(recordOf(action), 'kind') === kind ? action : undefined,
      ),
    };
  });

  return { reports: { automation: masked } };
}

export function automationTemplateSites(config: unknown): TemplateSite[] {
  return [
    ...collectConfigTemplates(actionsOfKind(config, 'alert'), REPORT_ALERT_SURFACE),
    ...collectConfigTemplates(actionsOfKind(config, 'dm'), REPORT_MEMBER_NOTICE_SURFACE),
  ];
}

function texts(message: StaffMessage | DmMessage): string[] {
  return collectMessageSites(message, '').map(({ text }) => text);
}

export function alertKeys(message: StaffMessage): Set<string> {
  return usedKeys(REPORT_ALERT_SURFACE, texts(message), { allowedOnly: true });
}

export function memberNoticeKeys(message: DmMessage): Set<string> {
  return usedKeys(REPORT_MEMBER_NOTICE_SURFACE, texts(message), { allowedOnly: true });
}

export function automationMessagePath(ruleIndex: number, actionIndex: number): string {
  return `reports.automation.${ruleIndex}.actions.${actionIndex}.message`;
}

export function renderReportAlert(
  message: StaffMessage,
  facts: ReportAlertFacts,
  now: number,
  basePath = '',
): MessageRender<StaffMessage> {
  return renderMessageTemplate(
    message,
    REPORT_ALERT_SURFACE,
    REPORT_ALERT_SURFACE.build(facts, { now }),
    { now, basePath },
  );
}

export function renderMemberNotice(
  message: DmMessage,
  facts: MemberNoticeFacts,
  now: number,
  basePath = '',
): MessageRender<DmMessage> {
  return renderMessageTemplate(
    message,
    REPORT_MEMBER_NOTICE_SURFACE,
    REPORT_MEMBER_NOTICE_SURFACE.build(facts, { now }),
    { now, basePath },
  );
}
