import {
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  clipGraphemes,
  collectConfigTemplates,
  collectMessageSites,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MessageRender,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  renderMessageTemplate,
  renderTemplate,
  SAMPLE_BOT,
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
} from '@proton/core/placeholders';
import {
  AUDITED_DIRECTIONS,
  type DmMessage,
  PUNISH_KINDS,
  type PunishDirection,
  type PunishKind,
  UNPUNISH_KINDS,
  type UnpunishKind,
} from './punish/config.ts';
import {
  AUTOMATION_SURFACES,
  automationTemplateSites,
  REPORT_ALERT_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
} from './reports/automation-surfaces.ts';
import {
  REPORT_ACCEPTED_SURFACE,
  REPORT_DISMISSED_SURFACE,
  REPORT_NOTICE_SURFACES,
  REPORT_SUBMITTED_SURFACE,
} from './reports/surfaces.ts';

export {
  AUTOMATION_SURFACES,
  REPORT_ACCEPTED_SURFACE,
  REPORT_ALERT_SURFACE,
  REPORT_DISMISSED_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
  REPORT_NOTICE_SURFACES,
  REPORT_SUBMITTED_SURFACE,
};

export const PUNISHED_EVENT = 'moderation.punished';
export const UNPUNISHED_EVENT = 'moderation.unpunished';
export const AUDIT_REASON_EVENT = 'moderation.audit_reason';

export const AUDIT_REASON_MAX = 512;

export type AuditedDirection = (typeof AUDITED_DIRECTIONS)[number];

export const PUNISHMENT_ACTIONS: Readonly<Record<PunishDirection, string>> = {
  ban: 'banned',
  unban: 'unbanned',
  kick: 'kicked',
  timeout: 'timed out',
  untimeout: 'released from timeout',
  warn: 'warned',
  unwarn: 'cleared of a warning',
};

export const LIFTED: Readonly<Record<UnpunishKind, PunishKind>> = {
  unban: 'ban',
  untimeout: 'timeout',
  unwarn: 'warn',
};

export interface PunishmentNoticeFacts {
  direction: PunishDirection;
  reason: string | null;
  durationMs: number | null;
  expiresAt: number | null;
  expired: boolean;
  caseId: string | null;
  user: UserFacts | null;
  moderator: UserFacts | null;
  server: ServerFacts | null;
  bot: BotFacts | null;
}

export interface AuditReasonFacts {
  moderatorId: string;
  moderatorName: string | null;
  reason: string | null;
  durationMs: number | null;
}

const GROUP = 'Punishment';
const HOUR = 3_600_000;

const TYPE: PlaceholderDefinitionInput = {
  key: 'punishment.type',
  label: 'Type',
  description: 'The punishment as one word: ban, kick, timeout or warn',
  group: GROUP,
  type: 'text',
  example: v.text('timeout'),
};

const ACTION: PlaceholderDefinitionInput = {
  key: 'punishment.action',
  label: 'What was done',
  description: 'What happened to the member, like banned or timed out',
  group: GROUP,
  type: 'text',
  example: v.text('timed out'),
};

const REASON: PlaceholderDefinitionInput = {
  key: 'punishment.reason',
  label: 'Reason',
  description: 'The reason the moderator gave. Empty when there was none.',
  group: GROUP,
  type: 'text',
  example: v.text('Posting invite links'),
};

const DURATION: PlaceholderDefinitionInput = {
  key: 'punishment.duration',
  label: 'Duration',
  description: 'How long it lasts. Empty for a permanent ban, a kick or a warning.',
  group: GROUP,
  type: 'duration',
  example: v.duration(HOUR),
};

const EXPIRES_AT: PlaceholderDefinitionInput = {
  key: 'punishment.expires_at',
  label: 'Ends',
  description: "When it ends on its own. Empty when it doesn't.",
  group: GROUP,
  type: 'datetime',
  example: v.datetime(SAMPLE_NOW + HOUR),
};

const EXPIRED: PlaceholderDefinitionInput = {
  key: 'punishment.expired',
  label: 'Ended on its own',
  description: 'Yes when the punishment ran out, no when a moderator lifted it',
  group: GROUP,
  type: 'boolean',
  example: v.boolean(false),
};

const AUDIT_REASON: PlaceholderDefinitionInput = {
  key: 'punishment.audit_reason',
  label: 'Audit-log reason',
  description: "What Proton wrote in Discord's audit log. Staff only, never sent to the member.",
  group: GROUP,
  type: 'text',
  example: v.text('Kestrel: Posting invite links'),
  sensitivity: 'staff_only',
};

const CASE_ID: PlaceholderDefinitionInput = {
  key: 'case.id',
  label: 'Case ID',
  description: 'The case Proton recorded for it, like K7f3M2q',
  group: 'Case',
  type: 'text',
  example: v.text('K7f3M2q'),
};

function noticeDefinitions(lifted: boolean): PlaceholderDefinitionInput[] {
  return [
    TYPE,
    ACTION,
    REASON,
    DURATION,
    EXPIRES_AT,
    ...(lifted ? [EXPIRED] : []),
    AUDIT_REASON,
    CASE_ID,
    ...userDefinitions('user', { member: false }),
    ...userDefinitions('moderator', { member: false }),
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

const MODERATOR_AUDIT_KEYS: ReadonlySet<string> = new Set(['moderator.id', 'moderator.username']);

const AUDIT_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  REASON,
  DURATION,
  ...userDefinitions('moderator', { member: false }).filter(({ key }) =>
    MODERATOR_AUDIT_KEYS.has(key),
  ),
  ...timeDefinitions(),
];

function typeOfNotice(direction: PunishDirection): PunishKind {
  switch (direction) {
    case 'unban':
    case 'untimeout':
    case 'unwarn':
      return LIFTED[direction];
    default:
      return direction;
  }
}

function noticeLookup(facts: PunishmentNoticeFacts, env: BuildEnv): PlaceholderLookup {
  return lookupFrom({
    'punishment.type': v.text(typeOfNotice(facts.direction)),
    'punishment.action': v.text(PUNISHMENT_ACTIONS[facts.direction]),
    'punishment.reason':
      facts.reason === null || facts.reason === ''
        ? v.notSet('no reason was given')
        : v.text(facts.reason),
    'punishment.duration':
      facts.durationMs === null ? v.notSet('it has no set length') : v.duration(facts.durationMs),
    'punishment.expires_at':
      facts.expiresAt === null
        ? v.notSet("it doesn't end on its own")
        : v.datetime(facts.expiresAt),
    'punishment.expired': v.boolean(facts.expired),
    'punishment.audit_reason': v.restricted('the audit-log reason is for staff only'),
    'case.id': facts.caseId === null ? v.notSet('no case was recorded') : v.text(facts.caseId),
    ...buildUserValues('user', facts.user, null, env.now),
    ...buildUserValues('moderator', facts.moderator, null, env.now),
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
  });
}

function auditLookup(facts: AuditReasonFacts, env: BuildEnv): PlaceholderLookup {
  return lookupFrom({
    'moderator.id': v.text(facts.moderatorId),
    'moderator.username':
      facts.moderatorName === null
        ? v.notSet("Proton didn't read their name")
        : v.text(facts.moderatorName),
    'punishment.reason':
      facts.reason === null || facts.reason === ''
        ? v.notSet('no reason was given')
        : v.text(facts.reason),
    'punishment.duration':
      facts.durationMs === null ? v.notSet('it has no set length') : v.duration(facts.durationMs),
    ...buildTimeValues(env.now),
  });
}

function messageFields(directions: readonly PunishDirection[]): TemplateFieldSpec[] {
  return directions.flatMap((direction) =>
    MESSAGE_TEMPLATE_FIELDS.map((spec) => ({
      ...spec,
      path: `punish.notifications.messages.${direction}.${spec.path}`,
    })),
  );
}

const AUDIT_LABELS: Readonly<Record<AuditedDirection, string>> = {
  ban: 'Ban audit-log reason',
  unban: 'Unban audit-log reason',
  kick: 'Kick audit-log reason',
  timeout: 'Timeout audit-log reason',
  untimeout: 'Timeout removal audit-log reason',
};

const AUDIT_FIELDS: readonly TemplateFieldSpec[] = AUDITED_DIRECTIONS.map((direction) => ({
  path: `punish.types.${direction}.auditReason`,
  kind: 'plain_text',
  label: AUDIT_LABELS[direction],
  limit: AUDIT_REASON_MAX,
}));

const SAMPLE_MODERATOR: UserFacts = Object.freeze({
  id: '100000000000000030',
  username: 'kestrel',
  globalName: 'Kestrel',
  avatarHash: null,
});

const SAMPLE_GUILD = SAMPLE_SERVER.name ?? 'Proton HQ';

const SAMPLE_REASON = 'Posting invite links';

export const PUNISHED_SURFACE: PlaceholderSurface<PunishmentNoticeFacts> =
  definePlaceholderSurface<PunishmentNoticeFacts>({
    id: 'moderation.punished',
    module: 'moderation',
    label: 'Punishment message',
    event: PUNISHED_EVENT,
    audience: 'member_private',
    fields: messageFields(PUNISH_KINDS),
    definitions: noticeDefinitions(false),
    build: noticeLookup,
    samples: [
      {
        id: 'punishment',
        label: `Sample: ${SAMPLE_MEMBER.user.globalName ?? 'a member'} timed out in ${SAMPLE_GUILD} for an hour`,
        facts: Object.freeze({
          direction: 'timeout' as const,
          reason: SAMPLE_REASON,
          durationMs: HOUR,
          expiresAt: SAMPLE_NOW + HOUR,
          expired: false,
          caseId: 'K7f3M2q',
          user: SAMPLE_MEMBER.user,
          moderator: SAMPLE_MODERATOR,
          server: SAMPLE_SERVER,
          bot: SAMPLE_BOT,
        }),
      },
    ],
  });

export const UNPUNISHED_SURFACE: PlaceholderSurface<PunishmentNoticeFacts> =
  definePlaceholderSurface<PunishmentNoticeFacts>({
    id: 'moderation.unpunished',
    module: 'moderation',
    label: 'Punishment lifted message',
    event: UNPUNISHED_EVENT,
    audience: 'member_private',
    fields: messageFields(UNPUNISH_KINDS),
    definitions: noticeDefinitions(true),
    build: noticeLookup,
    samples: [
      {
        id: 'punishment',
        label: `Sample: ${SAMPLE_MEMBER.user.globalName ?? 'a member'}'s timeout in ${SAMPLE_GUILD} ended early`,
        facts: Object.freeze({
          direction: 'untimeout' as const,
          reason: 'Appeal accepted',
          durationMs: null,
          expiresAt: null,
          expired: false,
          caseId: 'P2m9QxL',
          user: SAMPLE_MEMBER.user,
          moderator: SAMPLE_MODERATOR,
          server: SAMPLE_SERVER,
          bot: SAMPLE_BOT,
        }),
      },
    ],
  });

export const AUDIT_REASON_SURFACE: PlaceholderSurface<AuditReasonFacts> =
  definePlaceholderSurface<AuditReasonFacts>({
    id: 'moderation.audit_reason',
    module: 'moderation',
    label: 'Audit-log reason',
    event: AUDIT_REASON_EVENT,
    audience: 'staff_only',
    fields: AUDIT_FIELDS,
    definitions: AUDIT_DEFINITIONS,
    build: auditLookup,
    samples: [
      {
        id: 'punishment',
        label: `Sample: ${SAMPLE_MODERATOR.globalName ?? 'a moderator'} times a member out for an hour`,
        facts: Object.freeze({
          moderatorId: SAMPLE_MODERATOR.id,
          moderatorName: SAMPLE_MODERATOR.username,
          reason: SAMPLE_REASON,
          durationMs: HOUR,
        }),
      },
    ],
  });

export const PUNISH_SURFACES: readonly PlaceholderSurface<unknown>[] = [
  AUDIT_REASON_SURFACE,
  PUNISHED_SURFACE,
  UNPUNISHED_SURFACE,
];

export function templatesOf(surfaces: readonly PlaceholderSurface<unknown>[]): ModuleTemplates {
  return Object.freeze({
    surfaces: Object.freeze(Object.fromEntries(surfaces.map((surface) => [surface.id, surface]))),
    collect: (config: unknown) =>
      surfaces.flatMap((surface) => collectConfigTemplates(config, surface)),
  });
}

export const punishTemplates: ModuleTemplates = templatesOf(PUNISH_SURFACES);

export const REPORT_SURFACES: readonly PlaceholderSurface<unknown>[] = [
  ...REPORT_NOTICE_SURFACES,
  ...AUTOMATION_SURFACES,
];

export const MODERATION_SURFACES: readonly PlaceholderSurface<unknown>[] = [
  ...PUNISH_SURFACES,
  ...REPORT_SURFACES,
];

const reportNoticeTemplates = templatesOf(REPORT_NOTICE_SURFACES);

export const moderationTemplates: ModuleTemplates = Object.freeze({
  surfaces: templatesOf(MODERATION_SURFACES).surfaces,
  collect: (config: unknown) => [
    ...punishTemplates.collect(config),
    ...reportNoticeTemplates.collect(config),
    ...automationTemplateSites(config),
  ],
});

export function noticeSurface(
  direction: PunishDirection,
): PlaceholderSurface<PunishmentNoticeFacts> {
  switch (direction) {
    case 'unban':
    case 'untimeout':
    case 'unwarn':
      return UNPUNISHED_SURFACE;
    default:
      return PUNISHED_SURFACE;
  }
}

export function noticeTemplates(message: DmMessage): string[] {
  return collectMessageSites(message, '').map(({ text }) => text);
}

export function noticeKeys(direction: PunishDirection, message: DmMessage): Set<string> {
  return usedKeys(noticeSurface(direction), noticeTemplates(message), { allowedOnly: true });
}

export function renderPunishmentNotice(
  message: DmMessage,
  facts: PunishmentNoticeFacts,
  now: number,
): MessageRender<DmMessage> {
  const surface = noticeSurface(facts.direction);

  return renderMessageTemplate(message, surface, surface.build(facts, { now }), {
    now,
    basePath: `punish.notifications.messages.${facts.direction}`,
  });
}

export function auditReasonKeys(template: string): Set<string> {
  return usedKeys(AUDIT_REASON_SURFACE, [template], { allowedOnly: true });
}

export function renderAuditReasonTemplate(
  template: string,
  facts: AuditReasonFacts,
  now: number,
): string {
  const rendered = renderTemplate(template, AUDIT_REASON_SURFACE.build(facts, { now }), {
    registry: AUDIT_REASON_SURFACE.registry,
    field: 'plain_text',
    event: AUDIT_REASON_SURFACE.event,
    audience: AUDIT_REASON_SURFACE.audience,
    now,
  });

  return clipGraphemes(rendered.output.trim(), AUDIT_REASON_MAX);
}
