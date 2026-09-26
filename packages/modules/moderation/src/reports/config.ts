import {
  type ConfigWriteIssue,
  durationStringSchema,
  liftLegacyMessage,
  messageObjectSchema,
  REPORT_STATUSES,
  refineMessage,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';
import {
  type DmMessage,
  dmMessageSchema,
  PUNISH_KINDS,
  refuseInteractive,
} from '../punish/config.ts';

export const REPORTER_MODES = ['everyone', 'only', 'except'] as const;
export const CHANNEL_MODES = ['all', 'only', 'except'] as const;
export const CLOSE_MODES = ['keep', 'move', 'delete'] as const;

export type ReporterMode = (typeof REPORTER_MODES)[number];
export type ChannelMode = (typeof CHANNEL_MODES)[number];
export type CloseMode = (typeof CLOSE_MODES)[number];

export const METHOD_OFF_HINT =
  'Discord still lists it under Apps, and anyone who uses it is told it’s off. To hide it, turn ' +
  'it off on the Commands page of the Proton dashboard.';

export const COMMAND_OFF_HINT =
  'Discord still suggests it when members type /, and anyone who uses it is told it’s off. To ' +
  'hide it, turn it off on the Commands page of the Proton dashboard.';

const STAFF_ONLY_LINKS =
  'a staff alert can only have link buttons. Proton doesn’t answer other buttons or menus on an ' +
  'alert, so make it a link button or remove it.';

export const staffMessageSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine((message, ctx) => {
    refineMessage(message, ctx);
    refuseInteractive(message, ctx, STAFF_ONLY_LINKS);
  }),
);

export type StaffMessage = z.infer<typeof staffMessageSchema>;

const snowflakes = z.array(snowflakeSchema);
const roleIds = snowflakes.max(25).default([]);
const ruleId = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);

export const reportReasonSchema = z.object({
  id: ruleId,
  label: z.string().trim().min(1).max(100),
  description: z.string().max(100).default(''),
});

export type ReportReason = z.infer<typeof reportReasonSchema>;

export const closingSchema = z.object({
  mode: z.enum(CLOSE_MODES).default('keep'),
  channelId: snowflakeSchema.optional(),
  delay: durationStringSchema.nullable().default(null),
});

export type Closing = z.infer<typeof closingSchema>;

const SILENT = { everyone: false, roles: false, users: false };

function reporterDm(title: string, description: string): DmMessage {
  return dmMessageSchema.parse({ mentions: SILENT, embeds: [{ title, description }] });
}

export const DEFAULT_REPORT_NOTIFICATIONS = {
  submitted: reporterDm(
    'Report received',
    'Staff in **{server.name}** will review report `{report.id}` about {target.username}.',
  ),
  accepted: reporterDm(
    'Your report was accepted',
    'Staff in **{server.name}** reviewed report `{report.id}` about {target.username} and ' +
      'took action. Thank you for reporting it.',
  ),
  dismissed: reporterDm(
    'Your report was reviewed',
    'Staff in **{server.name}** reviewed report `{report.id}` about {target.username} and ' +
      'closed it without action.',
  ),
} as const satisfies Record<string, DmMessage>;

export const DEFAULT_STAFF_ALERT: StaffMessage = staffMessageSchema.parse({
  mentions: { everyone: false, roles: true, users: false },
  embeds: [
    {
      title: 'Several members reported {target.username}',
      description:
        '{report.reporter_count} different members have filed {report.total_reports} reports ' +
        'about {target.mention}. Latest report: `{report.id}`.',
      footer: { text: 'Rule: {rule.name}' },
    },
  ],
});

function notification(message: DmMessage, enabled: boolean) {
  return z
    .object({
      enabled: z.boolean().default(enabled),
      message: dmMessageSchema.default(message),
    })
    .prefault({});
}

export const automationActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('alert'),
    channelId: snowflakeSchema.optional(),
    roleIds: snowflakes.max(10).default([]),
    message: staffMessageSchema,
  }),
  z.object({ kind: z.literal('dm'), message: dmMessageSchema }),
  z.object({
    kind: z.literal('punish'),
    punishment: z.enum(PUNISH_KINDS),
    duration: durationStringSchema.nullable().default(null),
    reason: z.string().trim().min(1).max(512),
    notify: z.enum(['inherit', 'send', 'skip']).default('inherit'),
  }),
  z.object({ kind: z.literal('add_role'), roleId: snowflakeSchema }),
  z.object({ kind: z.literal('remove_role'), roleId: snowflakeSchema }),
]);

export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationRuleSchema = z.object({
  id: ruleId,
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  match: z.enum(['all', 'any']).default('all'),
  window: durationStringSchema.default('24h'),
  statuses: z.array(z.enum(REPORT_STATUSES)).min(1).default(['open', 'in_review']),
  conditions: z
    .object({
      reports: z.number().int().min(1).max(100).nullable().default(null),
      reporters: z.number().int().min(1).max(100).nullable().default(null),
      unreviewedFor: durationStringSchema.nullable().default(null),
    })
    .prefault({}),
  actions: z.array(automationActionSchema).max(5).default([]),
  acknowledgedRisk: z.boolean().default(false),
});

export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const DEFAULT_REPORT_REASONS: ReportReason[] = [
  { id: 'spam', label: 'Spam or flooding', description: '' },
  { id: 'harassment', label: 'Harassment or hate', description: '' },
  { id: 'nsfw', label: 'Inappropriate content', description: '' },
  { id: 'scam', label: 'Scam or suspicious link', description: '' },
  { id: 'impersonation', label: 'Impersonation', description: '' },
];

export const DEFAULT_REPORT_AUTOMATION: AutomationRule[] = [
  {
    id: 'several',
    name: 'Several members report the same person',
    enabled: true,
    match: 'all',
    window: '24h',
    statuses: ['open', 'in_review'],
    conditions: { reports: null, reporters: 3, unreviewedFor: null },
    actions: [{ kind: 'alert', roleIds: [], message: DEFAULT_STAFF_ALERT }],
    acknowledgedRisk: false,
  },
];

export const reportsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.optional(),
  notifyRoleIds: snowflakes.max(10).default([]),
  methods: z
    .object({
      command: z.boolean().default(true),
      userMenu: z.boolean().default(true),
      messageMenu: z.boolean().default(true),
      reaction: z.boolean().default(false),
    })
    .prefault({}),
  reaction: z
    .object({
      emoji: z.string().min(1).max(64).default('🚩'),
      reasonId: z.string().max(16).nullable().default(null),
      channelMode: z.enum(CHANNEL_MODES).default('all'),
      channelIds: snowflakes.max(50).default([]),
      removeReaction: z.boolean().default(true),
      channelFallback: z.boolean().default(false),
    })
    .prefault({}),
  reasons: z.array(reportReasonSchema).max(25).default(DEFAULT_REPORT_REASONS),
  allowCustomReason: z.boolean().default(true),
  requireReason: z.boolean().default(true),
  requireComment: z.boolean().default(false),
  requireAttachment: z.boolean().default(false),
  maxAttachments: z.number().int().min(1).max(10).default(4),
  copyReportedMessage: z.boolean().default(true),
  reporters: z.object({ mode: z.enum(REPORTER_MODES).default('everyone'), roleIds }).prefault({}),
  immuneRoleIds: roleIds,
  reviewerRoleIds: roleIds,
  blockedUserIds: snowflakes.max(100).default([]),
  limits: z
    .object({
      cooldown: durationStringSchema.default('2m'),
      cooldownBypassRoleIds: roleIds,
      maxOpenPerServer: z.number().int().min(1).max(1000).default(100),
      maxOpenPerMember: z.number().int().min(1).max(100).default(10),
      duplicateProtection: z.boolean().default(true),
      commentMin: z.number().int().min(0).max(500).default(0),
      commentMax: z.number().int().min(50).max(1000).default(1000),
      customReasonMax: z.number().int().min(20).max(200).default(200),
    })
    .prefault({}),
  closing: z
    .object({ accepted: closingSchema.prefault({}), dismissed: closingSchema.prefault({}) })
    .prefault({}),
  notifications: z
    .object({
      submitted: notification(DEFAULT_REPORT_NOTIFICATIONS.submitted, false),
      accepted: notification(DEFAULT_REPORT_NOTIFICATIONS.accepted, true),
      dismissed: notification(DEFAULT_REPORT_NOTIFICATIONS.dismissed, true),
    })
    .prefault({}),
  automation: z.array(automationRuleSchema).max(10).default(DEFAULT_REPORT_AUTOMATION),
});

export type ReportsConfig = z.infer<typeof reportsConfigSchema>;

export const REPORTS_DEFAULTS: ReportsConfig = {
  enabled: false,
  notifyRoleIds: [],
  methods: { command: true, userMenu: true, messageMenu: true, reaction: false },
  reaction: {
    emoji: '🚩',
    reasonId: null,
    channelMode: 'all',
    channelIds: [],
    removeReaction: true,
    channelFallback: false,
  },
  reasons: DEFAULT_REPORT_REASONS,
  allowCustomReason: true,
  requireReason: true,
  requireComment: false,
  requireAttachment: false,
  maxAttachments: 4,
  copyReportedMessage: true,
  reporters: { mode: 'everyone', roleIds: [] },
  immuneRoleIds: [],
  reviewerRoleIds: [],
  blockedUserIds: [],
  limits: {
    cooldown: '2m',
    cooldownBypassRoleIds: [],
    maxOpenPerServer: 100,
    maxOpenPerMember: 10,
    duplicateProtection: true,
    commentMin: 0,
    commentMax: 1000,
    customReasonMax: 200,
  },
  closing: {
    accepted: { mode: 'keep', delay: null },
    dismissed: { mode: 'keep', delay: null },
  },
  notifications: {
    submitted: { enabled: false, message: DEFAULT_REPORT_NOTIFICATIONS.submitted },
    accepted: { enabled: true, message: DEFAULT_REPORT_NOTIFICATIONS.accepted },
    dismissed: { enabled: true, message: DEFAULT_REPORT_NOTIFICATIONS.dismissed },
  },
  automation: DEFAULT_REPORT_AUTOMATION,
};

function uniqueIssues<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  path: (index: number) => string,
  message: (first: number, item: T) => string,
): ConfigWriteIssue[] {
  const seen = new Map<string, number>();
  const issues: ConfigWriteIssue[] = [];

  for (const [index, item] of items.entries()) {
    const key = keyOf(item);
    const first = seen.get(key);

    if (first === undefined) seen.set(key, index);
    else issues.push({ path: path(index), message: message(first, item) });
  }

  return issues;
}

function closingIssues(
  status: 'accepted' | 'dismissed',
  closing: Closing,
  reportChannelId: string | undefined,
): ConfigWriteIssue[] {
  if (closing.mode !== 'move') return [];

  const path = `reports.closing.${status}.channelId`;

  if (closing.channelId === undefined) {
    return [{ path, message: `Choose the channel ${status} reports are moved to.` }];
  }

  if (closing.channelId === reportChannelId) {
    return [
      {
        path,
        message:
          'Choose a channel other than the report channel. Moving a report there would leave it ' +
          'where it is.',
      },
    ];
  }

  return [];
}

function ruleIssues(rule: AutomationRule, index: number): ConfigWriteIssue[] {
  const path = `reports.automation.${index}`;
  const issues: ConfigWriteIssue[] = [];
  const { reports, reporters, unreviewedFor } = rule.conditions;

  if (reports === null && reporters === null && unreviewedFor === null) {
    issues.push({
      path: `${path}.conditions`,
      message: 'Set at least one condition. A rule without one never runs.',
    });
  }

  if (rule.actions.length === 0) {
    issues.push({ path: `${path}.actions`, message: 'Add at least one action.' });
  }

  if (rule.actions.some((action) => action.kind === 'punish') && !rule.acknowledgedRisk) {
    issues.push({
      path: `${path}.acknowledgedRisk`,
      message:
        'This rule punishes members before anyone reviews the reports. Confirm that you ' +
        'understand the risk before saving it.',
    });
  }

  return issues;
}

export function refineReportsWrite(reports: ReportsConfig): ConfigWriteIssue[] {
  const issues: ConfigWriteIssue[] = [];

  if (reports.requireReason && reports.reasons.length === 0 && !reports.allowCustomReason) {
    issues.push({
      path: 'reports.requireReason',
      message: 'Add a reason or let members write their own. Otherwise nobody can file a report.',
    });
  }

  if (reports.enabled && reports.channelId === undefined) {
    issues.push({
      path: 'reports.channelId',
      message: 'Choose a report channel. Proton posts every report there for staff to review.',
    });
  }

  if (reports.enabled && !Object.values(reports.methods).some(Boolean)) {
    issues.push({
      path: 'reports.methods',
      message: 'Turn on at least one way to report, or turn user reports off.',
    });
  }

  const reasonId = reports.reaction.reasonId;
  if (reasonId !== null && !reports.reasons.some((reason) => reason.id === reasonId)) {
    issues.push({
      path: 'reports.reaction.reasonId',
      message: `There’s no report reason with the ID '${reasonId}'. Pick one of the reasons.`,
    });
  }

  issues.push(
    ...uniqueIssues(
      reports.reasons,
      (reason) => reason.id.toLowerCase(),
      (index) => `reports.reasons.${index}.id`,
      (first, reason) => `Reason ${first + 1} already uses the ID '${reason.id}'.`,
    ),
    ...uniqueIssues(
      reports.reasons,
      (reason) => reason.label.trim().toLowerCase(),
      (index) => `reports.reasons.${index}.label`,
      (first, reason) => `Reason ${first + 1} is already called '${reason.label.trim()}'.`,
    ),
    ...closingIssues('accepted', reports.closing.accepted, reports.channelId),
    ...closingIssues('dismissed', reports.closing.dismissed, reports.channelId),
    ...reports.automation.flatMap(ruleIssues),
    ...uniqueIssues(
      reports.automation,
      (rule) => rule.id.toLowerCase(),
      (index) => `reports.automation.${index}.id`,
      (first, rule) => `Rule ${first + 1} already uses the ID '${rule.id}'.`,
    ),
  );

  const { limits } = reports;

  if (limits.maxOpenPerMember > limits.maxOpenPerServer) {
    issues.push({
      path: 'reports.limits.maxOpenPerMember',
      message: `This can’t be more than the server-wide limit of ${limits.maxOpenPerServer}.`,
    });
  }

  if (limits.commentMin > limits.commentMax) {
    issues.push({
      path: 'reports.limits.commentMin',
      message: `The shortest comment can’t be longer than the longest, ${limits.commentMax} characters.`,
    });
  }

  return issues;
}
