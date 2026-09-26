import {
  countV2Components,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_TOTAL_MAX,
  embedsLength,
  labelOf,
  MESSAGE_CONTENT_MAX,
  type ModuleContext,
  V2_COMPONENTS_MAX,
} from '@proton/core';
import {
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  clipGraphemes,
  collectMessageSites,
  definePlaceholderSurface,
  escapeDiscordMarkdown,
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
  SAMPLE_REPORTER,
  SAMPLE_SERVER,
  type ServerFacts,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
} from '@proton/core/placeholders';
import type { DmMessage } from '../punish/config.ts';
import {
  type NotificationKind,
  REPORT_COMMAND,
  type ReportMethod,
  type ReportStatus,
} from './types.ts';

export const REPORT_SUBMITTED_EVENT = 'moderation.report_submitted';
export const REPORT_ACCEPTED_EVENT = 'moderation.report_accepted';
export const REPORT_DISMISSED_EVENT = 'moderation.report_dismissed';

export const REPORT_METHOD_NAMES: Readonly<Record<ReportMethod, string>> = {
  command: '/report',
  user_menu: 'Report user',
  message_menu: 'Report message',
  reaction: 'a reaction',
};

export function reportMethodName(
  labels: Pick<ModuleContext, 'commandLabel'>,
  method: ReportMethod,
): string {
  return method === 'command' ? labelOf(labels, REPORT_COMMAND) : REPORT_METHOD_NAMES[method];
}

export const REPORT_STATUS_NAMES: Readonly<Record<ReportStatus, string>> = {
  open: 'open',
  in_review: 'in review',
  accepted: 'accepted',
  dismissed: 'dismissed',
};

export interface ReportNoticeFacts {
  report: {
    id: string;
    number: number;
    status: ReportStatus;
    method: ReportMethod;
    methodName?: string;
    reason: string | null;
    customReason: string | null;
    comment: string | null;
    createdAt: number;
    messageUrl: string | null;
    action: string | null;
    explanation: string | null;
  };
  user: UserFacts | null;
  target: UserFacts | null;
  moderator: UserFacts | null;
  server: ServerFacts | null;
  bot: BotFacts | null;
}

const GROUP = 'Report';
const HOUR = 3_600_000;

const SAMPLE_REPORT_ID = 'Rk3P9aQ';
const SAMPLE_MESSAGE_URL = `https://discord.com/channels/${SAMPLE_SERVER.id}/100000000000000040/100000000000000041`;

const SAMPLE_MODERATOR: UserFacts = Object.freeze({
  id: '100000000000000030',
  username: 'kestrel',
  globalName: 'Kestrel',
  avatarHash: null,
});

const REPORT_KEYS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'report.id',
    label: 'Report ID',
    description: 'The report’s ID, like Rk3P9aQ',
    group: GROUP,
    type: 'text',
    example: v.text(SAMPLE_REPORT_ID),
  },
  {
    key: 'report.number',
    label: 'Report number',
    description: 'The report’s number in this server’s queue',
    group: GROUP,
    type: 'integer',
    example: v.integer(42),
  },
  {
    key: 'report.status',
    label: 'Status',
    description: 'Where the report stands: open, in review, accepted or dismissed',
    group: GROUP,
    type: 'text',
    example: v.text('open'),
  },
  {
    key: 'report.method',
    label: 'Filed with',
    description: 'How the member filed it, like /report or Report message',
    group: GROUP,
    type: 'text',
    example: v.text('Report message'),
  },
  {
    key: 'report.reason',
    label: 'Reason',
    description: 'The reason picked from the server’s list. Empty when none was picked.',
    group: GROUP,
    type: 'text',
    example: v.text('Spam or flooding'),
  },
  {
    key: 'report.custom_reason',
    label: 'Own reason',
    description: 'The reason the member typed themselves. Empty when they typed none.',
    group: GROUP,
    type: 'text',
    example: v.text('Keeps posting the same link'),
  },
  {
    key: 'report.comment',
    label: 'Details',
    description: 'The details the member added. Empty when they added none.',
    group: GROUP,
    type: 'text',
    example: v.text('Started in #general about an hour ago.'),
  },
  {
    key: 'report.created_at',
    label: 'Filed',
    description: 'When the report was filed',
    group: GROUP,
    type: 'datetime',
    example: v.datetime(SAMPLE_NOW - HOUR),
  },
  {
    key: 'report.message_url',
    label: 'Reported message link',
    description: 'A link to the reported message. Empty for a report about a member.',
    group: GROUP,
    type: 'url',
    example: v.url(SAMPLE_MESSAGE_URL),
  },
];

const ACTION_KEY: PlaceholderDefinitionInput = {
  key: 'report.action',
  label: 'Action taken',
  description: 'What staff did, like Ban or No punishment',
  group: GROUP,
  type: 'text',
  example: v.text('Ban'),
};

const EXPLANATION_KEY: PlaceholderDefinitionInput = {
  key: 'report.explanation',
  label: 'Note from staff',
  description:
    'The note staff wrote for the member who reported. Empty when they wrote none. If you leave ' +
    'it out of the message, Proton adds the note at the end.',
  group: GROUP,
  type: 'text',
  example: v.text('We looked into it and the messages were a joke between friends.'),
};

export const STAFF_NOTE_LABEL = 'Note from staff';

const STAFF_ONLY_KEYS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'report.internal_note',
    label: 'Internal note',
    description: 'The staff-only note on the decision. Never sent to members.',
    group: GROUP,
    type: 'text',
    example: v.text('Second report this week.'),
    sensitivity: 'staff_only',
  },
  {
    key: 'report.case_ids',
    label: 'Case IDs',
    description: 'The cases the report led to. Staff only.',
    group: GROUP,
    type: 'text',
    example: v.text('K7f3M2q'),
    sensitivity: 'staff_only',
  },
  {
    key: 'report.url',
    label: 'Dashboard link',
    description: 'A link to the report in the Proton dashboard. Staff only.',
    group: GROUP,
    type: 'url',
    example: v.url('https://prtn.xyz/dashboard'),
    sensitivity: 'staff_only',
  },
  {
    key: 'report.reporter_count',
    label: 'Different reporters',
    description: 'How many different members reported the same member. Staff only.',
    group: GROUP,
    type: 'integer',
    example: v.integer(3),
    sensitivity: 'staff_only',
  },
  {
    key: 'report.total_reports',
    label: 'Total reports',
    description: 'How many reports there are about the same member. Staff only.',
    group: GROUP,
    type: 'integer',
    example: v.integer(4),
    sensitivity: 'staff_only',
  },
];

function definitionsFor(kind: NotificationKind): PlaceholderDefinitionInput[] {
  return [
    ...REPORT_KEYS,
    ...(kind === 'accepted' ? [ACTION_KEY] : []),
    ...(kind === 'submitted' ? [] : [EXPLANATION_KEY]),
    ...STAFF_ONLY_KEYS,
    ...userDefinitions('user', { member: false }),
    ...userDefinitions('target', { member: false }),
    ...(kind === 'submitted' ? [] : userDefinitions('moderator', { member: false })),
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

function textOrUnset(value: string | null, reason: string): ResolvedValue {
  return value === null || value.trim() === '' ? v.notSet(reason) : v.text(value);
}

const STAFF_ONLY = 'only staff can see this';

function noticeLookup(facts: ReportNoticeFacts, env: BuildEnv): PlaceholderLookup {
  const { report } = facts;

  return lookupFrom({
    'report.id': v.text(report.id),
    'report.number': v.integer(report.number),
    'report.status': v.text(REPORT_STATUS_NAMES[report.status]),
    'report.method': v.text(report.methodName ?? REPORT_METHOD_NAMES[report.method]),
    'report.reason': textOrUnset(report.reason, 'no reason was picked'),
    'report.custom_reason': textOrUnset(report.customReason, 'they typed no reason of their own'),
    'report.comment': textOrUnset(report.comment, 'they added no details'),
    'report.created_at': v.datetime(report.createdAt),
    'report.message_url':
      report.messageUrl === null
        ? v.notSet('the report is about a member, not a message')
        : v.url(report.messageUrl),
    'report.action': textOrUnset(report.action, 'no action was recorded'),
    'report.explanation': textOrUnset(report.explanation, 'staff wrote no note'),
    'report.internal_note': v.restricted(STAFF_ONLY),
    'report.case_ids': v.restricted(STAFF_ONLY),
    'report.url': v.restricted(STAFF_ONLY),
    'report.reporter_count': v.restricted(STAFF_ONLY),
    'report.total_reports': v.restricted(STAFF_ONLY),
    ...buildUserValues('user', facts.user, null, env.now),
    ...buildUserValues('target', facts.target, null, env.now),
    ...buildUserValues('moderator', facts.moderator, null, env.now),
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
  });
}

function fieldsFor(kind: NotificationKind): TemplateFieldSpec[] {
  return MESSAGE_TEMPLATE_FIELDS.map((spec) => ({
    ...spec,
    path: `reports.notifications.${kind}.message.${spec.path}`,
  }));
}

function sample(
  status: ReportStatus,
  extra: Partial<ReportNoticeFacts['report']> = {},
  moderator: UserFacts | null = null,
): ReportNoticeFacts {
  return Object.freeze({
    report: Object.freeze({
      id: SAMPLE_REPORT_ID,
      number: 42,
      status,
      method: 'message_menu' as const,
      reason: 'Spam or flooding',
      customReason: null,
      comment: 'Started in #general about an hour ago.',
      createdAt: SAMPLE_NOW - HOUR,
      messageUrl: SAMPLE_MESSAGE_URL,
      action: null,
      explanation: null,
      ...extra,
    }),
    user: SAMPLE_REPORTER.user,
    target: SAMPLE_MEMBER.user,
    moderator,
    server: SAMPLE_SERVER,
    bot: SAMPLE_BOT,
  });
}

const REPORTER_NAME = SAMPLE_REPORTER.user.globalName ?? 'A member';
const TARGET_NAME = SAMPLE_MEMBER.user.globalName ?? 'a member';

export const REPORT_SUBMITTED_SURFACE: PlaceholderSurface<ReportNoticeFacts> =
  definePlaceholderSurface<ReportNoticeFacts>({
    id: 'moderation.report_submitted',
    module: 'moderation',
    label: 'Report received message',
    event: REPORT_SUBMITTED_EVENT,
    audience: 'member_private',
    fields: fieldsFor('submitted'),
    definitions: definitionsFor('submitted'),
    build: noticeLookup,
    samples: [
      {
        id: 'report',
        label: `Sample: ${REPORTER_NAME} reports a message by ${TARGET_NAME}`,
        facts: sample('open'),
      },
    ],
  });

export const REPORT_ACCEPTED_SURFACE: PlaceholderSurface<ReportNoticeFacts> =
  definePlaceholderSurface<ReportNoticeFacts>({
    id: 'moderation.report_accepted',
    module: 'moderation',
    label: 'Report accepted message',
    event: REPORT_ACCEPTED_EVENT,
    audience: 'member_private',
    fields: fieldsFor('accepted'),
    definitions: definitionsFor('accepted'),
    build: noticeLookup,
    samples: [
      {
        id: 'report',
        label: `Sample: staff ban ${TARGET_NAME} after ${REPORTER_NAME}’s report`,
        facts: sample(
          'accepted',
          { action: 'Ban', explanation: 'Thanks for flagging it. They won’t be back.' },
          SAMPLE_MODERATOR,
        ),
      },
    ],
  });

export const REPORT_DISMISSED_SURFACE: PlaceholderSurface<ReportNoticeFacts> =
  definePlaceholderSurface<ReportNoticeFacts>({
    id: 'moderation.report_dismissed',
    module: 'moderation',
    label: 'Report dismissed message',
    event: REPORT_DISMISSED_EVENT,
    audience: 'member_private',
    fields: fieldsFor('dismissed'),
    definitions: definitionsFor('dismissed'),
    build: noticeLookup,
    samples: [
      {
        id: 'report',
        label: `Sample: staff close ${REPORTER_NAME}’s report without action`,
        facts: sample(
          'dismissed',
          { explanation: 'We looked into it and the messages were a joke between friends.' },
          SAMPLE_MODERATOR,
        ),
      },
    ],
  });

export const REPORTER_NOTICE_SURFACES: Readonly<
  Record<NotificationKind, PlaceholderSurface<ReportNoticeFacts>>
> = {
  submitted: REPORT_SUBMITTED_SURFACE,
  accepted: REPORT_ACCEPTED_SURFACE,
  dismissed: REPORT_DISMISSED_SURFACE,
};

export const REPORT_NOTICE_SURFACES: readonly PlaceholderSurface<unknown>[] = [
  REPORT_SUBMITTED_SURFACE,
  REPORT_ACCEPTED_SURFACE,
  REPORT_DISMISSED_SURFACE,
];

export function reportNoticeKeys(kind: NotificationKind, message: DmMessage): Set<string> {
  return usedKeys(
    REPORTER_NOTICE_SURFACES[kind],
    collectMessageSites(message, '').map(({ text }) => text),
    { allowedOnly: true },
  );
}

function withStaffNote(message: DmMessage, note: string): DmMessage {
  const text = clipGraphemes(escapeDiscordMarkdown(note.trim()), EMBED_FIELD_VALUE_MAX);

  if (message.v2.length > 0) {
    if (countV2Components(message.v2) >= V2_COMPONENTS_MAX) return message;
    return {
      ...message,
      v2: [...message.v2, { kind: 'text', content: `**${STAFF_NOTE_LABEL}**\n${text}` }],
    };
  }

  const [first, ...rest] = message.embeds;
  const room = EMBED_TOTAL_MAX - embedsLength(message.embeds);
  if (
    first &&
    (first.fields?.length ?? 0) < EMBED_FIELDS_MAX &&
    STAFF_NOTE_LABEL.length + text.length <= room
  ) {
    const field = { name: STAFF_NOTE_LABEL, value: text, inline: false };
    return {
      ...message,
      embeds: [{ ...first, fields: [...(first.fields ?? []), field] }, ...rest],
    };
  }

  const line = `**${STAFF_NOTE_LABEL}:** ${text}`;
  const content = message.content?.trim() ? `${message.content.trim()}\n\n${line}` : line;
  return { ...message, content: clipGraphemes(content, MESSAGE_CONTENT_MAX) };
}

export function renderReportNotice(
  kind: NotificationKind,
  message: DmMessage,
  facts: ReportNoticeFacts,
  now: number,
): MessageRender<DmMessage> {
  const surface = REPORTER_NOTICE_SURFACES[kind];

  const rendered = renderMessageTemplate(message, surface, surface.build(facts, { now }), {
    now,
    basePath: `reports.notifications.${kind}.message`,
  });

  const note = facts.report.explanation?.trim() ?? '';
  if (!rendered.ok || kind === 'submitted' || note === '') return rendered;
  if (reportNoticeKeys(kind, message).has('report.explanation')) return rendered;

  return { ...rendered, message: withStaffNote(rendered.message, note) };
}
