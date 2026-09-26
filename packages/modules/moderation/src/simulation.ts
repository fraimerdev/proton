import type {
  ProtonMessage,
  SimulationAdapter,
  SimulationBuild,
  SimulationDescriptor,
  SimulationInput,
  SimulationPerson,
  SimulationScene,
} from '@proton/core';
import {
  MESSAGE_CONTENT_MAX,
  messageUrl,
  readBoolean,
  readChoice,
  readInteger,
  tryParseDuration,
} from '@proton/core';
import { clipGraphemes, type MessageRender, type UserFacts } from '@proton/core/placeholders';
import type { ModerationConfig } from './config.ts';
import {
  PUNISHED_SURFACE,
  PUNISHMENT_ACTIONS,
  renderPunishmentNotice,
  UNPUNISHED_SURFACE,
} from './placeholders.ts';
import {
  PUNISH_KINDS,
  type PunishDirection,
  type PunishKind,
  UNPUNISH_KINDS,
  type UnpunishKind,
} from './punish/config.ts';
import {
  automationMessagePath,
  REPORT_ALERT_SURFACE,
  REPORT_MEMBER_NOTICE_SURFACE,
  renderMemberNotice,
  renderReportAlert,
} from './reports/automation-surfaces.ts';
import {
  actionName,
  buildReportCard,
  type CardReport,
  type CardTarget,
  STATS_WINDOW_DAYS,
} from './reports/card.ts';
import type { AutomationAction, AutomationRule, StaffMessage } from './reports/config.ts';
import {
  REPORT_STATUS_NAMES,
  REPORTER_NOTICE_SURFACES,
  type ReportNoticeFacts,
  renderReportNotice,
} from './reports/surfaces.ts';
import {
  isActiveStatus,
  type NotificationKind,
  REPORT_STATUSES,
  type ReportEvidence,
  type ReportStatus,
} from './reports/types.ts';

const MODULE_ID = 'moderation';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DISCORD_EPOCH = 1_420_070_400_000;
const TEXT_CHANNEL = 0;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 7;
const SILENT = { everyone: false, roles: false, users: false };

const SAMPLE_DETAILS = 'Sample details: what a member adds when they file a report.';
const SAMPLE_MESSAGE = 'Sample message: the text of the reported message.';
const SAMPLE_REPORTER_NOTE = 'Sample note: what staff write to the member who reported.';

const PROTON_MODERATOR: UserFacts = Object.freeze({
  id: 'proton:moderation',
  username: null,
  globalName: 'Proton',
  avatarHash: null,
});

const EXPIRED_REASONS: Readonly<Record<Exclude<UnpunishKind, 'unwarn'>, string>> = {
  untimeout: 'Timeout expired.',
  unban: 'Temporary ban expired.',
};

const ACCEPT_ACTIONS = ['none', ...PUNISH_KINDS] as const;

const NO_ALERT = 'that automation rule has no staff alert. Add one to the rule, then test it.';
const NO_NOTICE =
  'that automation rule has no message for the reported member. Add one to the rule, then test it.';

type AlertAction = Extract<AutomationAction, { kind: 'alert' }>;
type DmAction = Extract<AutomationAction, { kind: 'dm' }>;

interface Source {
  channelId: string;
  messageId: string;
}

interface Staged {
  reportId: string;
  number: number;
  caseId: string;
  filedAt: number;
  source: Source | null;
}

interface Picked<A extends AutomationAction> {
  rule: AutomationRule;
  ruleIndex: number;
  action: A;
  actionIndex: number;
}

function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

function syntheticId(scene: SimulationScene, salt: string): string {
  return Array.from({ length: ID_LENGTH }, (_, index) =>
    ID_ALPHABET.charAt(hashOf(`${scene.eventId}:${salt}:${index}`) % ID_ALPHABET.length),
  ).join('');
}

function snowflakeAt(at: number): string {
  return (BigInt(Math.max(0, Math.floor(at) - DISCORD_EPOCH)) << 22n).toString();
}

function bySnowflake(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceChannelOf(config: ModerationConfig, scene: SimulationScene): string | null {
  const reportChannel = config.reports.channelId;
  const [oldest] = [...(scene.guildState?.channels.values() ?? [])]
    .filter((channel) => channel.type === TEXT_CHANNEL && channel.id !== reportChannel)
    .map((channel) => channel.id)
    .sort(bySnowflake);

  return oldest ?? scene.originChannel?.id ?? reportChannel ?? null;
}

function staged(
  config: ModerationConfig,
  scene: SimulationScene,
  options: { resolved: boolean; withMessage: boolean },
): Staged {
  const filedAt = options.resolved ? scene.now - HOUR : scene.now;
  const channelId = options.withMessage ? sourceChannelOf(config, scene) : null;

  return {
    reportId: syntheticId(scene, 'report'),
    number: 1 + (hashOf(`${scene.eventId}:number`) % 999),
    caseId: syntheticId(scene, 'case'),
    filedAt,
    source: channelId === null ? null : { channelId, messageId: snowflakeAt(filedAt - 5 * MINUTE) },
  };
}

function reasonAt(config: ModerationConfig, scene: SimulationScene): string | null {
  return config.reports.reasons[readInteger(scene.inputs, 'reasonIndex', 0)]?.label ?? null;
}

function evidenceOf(stage: Staged, scene: SimulationScene): ReportEvidence {
  const { source } = stage;
  if (source === null) return { links: [], attachments: [] };

  const { user } = scene.subject;

  return {
    links: [],
    attachments: [],
    message: {
      status: 'captured',
      snapshot: {
        id: source.messageId,
        channelId: source.channelId,
        authorId: user.id,
        authorName: user.username,
        authorBot: user.bot === true,
        url: messageUrl(scene.guildId, source.channelId, source.messageId),
        createdAt: stage.filedAt - 5 * MINUTE,
        editedAt: null,
        content: SAMPLE_MESSAGE,
        attachments: [],
        embeds: [],
        stickers: [],
        forwarded: false,
        forwardedContent: null,
        capturedFrom: 'interaction',
      },
    },
  };
}

function cardTarget(person: SimulationPerson): CardTarget {
  if (person.member === 'unavailable') {
    return { username: person.user.username, membership: 'unknown', joinedAt: null };
  }

  const joined = person.member.joinedAt ? Date.parse(person.member.joinedAt) : Number.NaN;
  return {
    username: person.user.username,
    membership: 'member',
    joinedAt: Number.isFinite(joined) ? joined : null,
  };
}

function refuse(humanReason: string): SimulationBuild {
  return { ok: false, humanReason, diagnostics: [] };
}

function delivered(rendered: MessageRender<ProtonMessage>, caption: string): SimulationBuild {
  if (!rendered.ok) {
    return { ok: false, humanReason: rendered.humanReason, diagnostics: rendered.diagnostics };
  }

  return {
    ok: true,
    caption,
    diagnostics: rendered.diagnostics,
    output: { kind: 'message', message: rendered.message, attachments: [] },
  };
}

function silenced(rendered: MessageRender<ProtonMessage>): MessageRender<ProtonMessage> {
  return rendered.ok
    ? { ...rendered, message: { ...rendered.message, mentions: SILENT } }
    : rendered;
}

function serverName(scene: SimulationScene): string {
  return scene.server?.name ?? 'this server';
}

const STATUS_INPUT: SimulationInput = {
  key: 'status',
  label: 'Status',
  kind: 'choice',
  options: [
    { value: 'open', label: 'Open' },
    { value: 'in_review', label: 'In review' },
    { value: 'accepted', label: 'Accepted' },
    { value: 'dismissed', label: 'Dismissed' },
  ],
  fallback: 'open',
};

const REASON_INPUT: SimulationInput = {
  key: 'reasonIndex',
  label: 'Reason',
  help: 'Which of the server’s report reasons to use, counting from 0. A number past the end of the list means no reason was picked.',
  kind: 'integer',
  min: 0,
  max: 24,
  fallback: 0,
};

const MESSAGE_INPUT: SimulationInput = {
  key: 'withMessage',
  label: 'About a message',
  help: 'On: the report was filed on a message. Off: it was filed about the member.',
  kind: 'boolean',
  fallback: true,
};

const ACTION_INPUT: SimulationInput = {
  key: 'action',
  label: 'Action taken',
  kind: 'choice',
  options: [
    { value: 'none', label: 'No punishment' },
    { value: 'warn', label: 'Warning' },
    { value: 'timeout', label: 'Timeout' },
    { value: 'kick', label: 'Kick' },
    { value: 'ban', label: 'Ban' },
  ],
  fallback: 'ban',
};

const RULE_INPUTS: SimulationInput[] = [
  {
    key: 'ruleIndex',
    label: 'Automation rule',
    kind: 'integer',
    min: 0,
    max: 9,
    fallback: 0,
    fixed: true,
  },
  {
    key: 'actionIndex',
    label: 'Action',
    kind: 'integer',
    min: 0,
    max: 4,
    fallback: 0,
    fixed: true,
  },
];

const REPORT_CARD_SIMULATION: SimulationAdapter<ModerationConfig> = {
  descriptor: {
    id: 'moderation.report_card',
    moduleId: MODULE_ID,
    label: 'Report card',
    summary: 'The card Proton posts in the report channel for staff to review a report.',
    configPath: 'reports.channelId',
    output: 'message',
    delivery: 'channel',
    channelPath: 'reports.channelId',
    subject: true,
    inputs: [STATUS_INPUT, REASON_INPUT, MESSAGE_INPUT],
    note:
      'No report is filed, claimed or acted on. You appear as both the reporter and the staff ' +
      'member, and the example member is the one reported.',
  },

  destination: (config) => config.reports.channelId ?? null,

  build(config, scene) {
    const status = readChoice(scene.inputs, 'status', REPORT_STATUSES, 'open');
    const active = isActiveStatus(status);
    const stage = staged(config, scene, {
      resolved: !active,
      withMessage: readBoolean(scene.inputs, 'withMessage', true),
    });
    const you = scene.actor.user.id;

    const report: CardReport = {
      id: stage.reportId,
      guildId: scene.guildId,
      number: stage.number,
      status,
      method: stage.source === null ? 'user_menu' : 'message_menu',
      reporterId: you,
      targetId: scene.subject.user.id,
      reason: reasonAt(config, scene),
      customReason: null,
      comment: SAMPLE_DETAILS,
      sourceChannelId: stage.source?.channelId ?? null,
      sourceMessageId: stage.source?.messageId ?? null,
      evidence: evidenceOf(stage, scene),
      evidencePurgedAt: null,
      assigneeId: status === 'in_review' ? you : null,
      resolvedBy: active ? null : you,
      actionKind: status === 'accepted' ? 'warn' : null,
      caseIds: status === 'accepted' ? [stage.caseId] : [],
      createdAt: stage.filedAt,
    };

    const message = buildReportCard({
      report,
      target: cardTarget(scene.subject),
      stats: { total: 1, distinctReporters: 1, open: active ? 1 : 0 },
      statsWindowDays: STATS_WINDOW_DAYS,
      notifyRoleIds: config.reports.notifyRoleIds,
      firstPost: active,
    });

    return {
      ok: true,
      caption: `report #${stage.number} about ${scene.subject.displayName}, ${REPORT_STATUS_NAMES[status]}`,
      diagnostics: [],
      output: { kind: 'message', message, attachments: [] },
    };
  },
};

const NOTICE_STATUSES: Readonly<Record<NotificationKind, ReportStatus>> = {
  submitted: 'open',
  accepted: 'accepted',
  dismissed: 'dismissed',
};

const NOTICE_COPY: Readonly<Record<NotificationKind, { label: string; summary: string }>> = {
  submitted: {
    label: 'Report received message',
    summary: 'The DM a member gets once their report is filed.',
  },
  accepted: {
    label: 'Report accepted message',
    summary: 'The DM a member gets when staff accept their report.',
  },
  dismissed: {
    label: 'Report dismissed message',
    summary: 'The DM a member gets when staff dismiss their report.',
  },
};

function reporterNotice(kind: NotificationKind): SimulationAdapter<ModerationConfig> {
  const descriptor: SimulationDescriptor = {
    id: REPORTER_NOTICE_SURFACES[kind].id,
    moduleId: MODULE_ID,
    ...NOTICE_COPY[kind],
    surfaceId: REPORTER_NOTICE_SURFACES[kind].id,
    configPath: `reports.notifications.${kind}.message`,
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [REASON_INPUT, MESSAGE_INPUT, ...(kind === 'accepted' ? [ACTION_INPUT] : [])],
    note:
      'Sent to you, as the reporter. No report is filed or reviewed, and the example member isn’t ' +
      'told anything.',
  };

  return {
    descriptor,

    build(config, scene) {
      const stage = staged(config, scene, {
        resolved: kind !== 'submitted',
        withMessage: readBoolean(scene.inputs, 'withMessage', true),
      });
      const taken = readChoice(scene.inputs, 'action', ACCEPT_ACTIONS, 'ban');

      const facts: ReportNoticeFacts = {
        report: {
          id: stage.reportId,
          number: stage.number,
          status: NOTICE_STATUSES[kind],
          method: stage.source === null ? 'user_menu' : 'message_menu',
          reason: reasonAt(config, scene),
          customReason: null,
          comment: SAMPLE_DETAILS,
          createdAt: stage.filedAt,
          messageUrl:
            stage.source === null
              ? null
              : messageUrl(scene.guildId, stage.source.channelId, stage.source.messageId),
          action: kind === 'accepted' ? actionName(taken === 'none' ? null : taken) : null,
          explanation: kind === 'submitted' ? null : SAMPLE_REPORTER_NOTE,
        },
        user: scene.actor.user,
        target: scene.subject.user,
        moderator: kind === 'submitted' ? null : scene.actor.user,
        server: scene.server,
        bot: scene.bot,
      };

      const rendered = renderReportNotice(
        kind,
        config.reports.notifications[kind].message,
        facts,
        scene.now,
      );

      return delivered(
        silenced(rendered),
        `report #${stage.number} about ${scene.subject.displayName}, ${REPORT_STATUS_NAMES[NOTICE_STATUSES[kind]]}`,
      );
    },
  };
}

function durationOf(raw: string | null): number | null {
  return raw === null ? null : tryParseDuration(raw);
}

function defaultReason(config: ModerationConfig, direction: PunishDirection): string | null {
  const typed = config.punish.types[direction].defaultReason.trim();
  return typed === '' ? null : typed;
}

function punishedDuration(config: ModerationConfig, kind: PunishKind): number | null {
  const { types } = config.punish;
  if (kind === 'timeout') return durationOf(types.timeout.defaultDuration) ?? HOUR;
  if (kind === 'ban') return durationOf(types.ban.defaultDuration);
  return null;
}

const PUNISHED_SIMULATION: SimulationAdapter<ModerationConfig> = {
  descriptor: {
    id: PUNISHED_SURFACE.id,
    moduleId: MODULE_ID,
    label: 'Punishment message',
    summary: 'The DM a member gets when they’re banned, kicked, timed out or warned.',
    surfaceId: PUNISHED_SURFACE.id,
    configPath: 'punish.notifications.messages',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [
      {
        key: 'kind',
        label: 'Punishment',
        kind: 'choice',
        options: [
          { value: 'ban', label: 'Ban' },
          { value: 'kick', label: 'Kick' },
          { value: 'timeout', label: 'Timeout' },
          { value: 'warn', label: 'Warning' },
        ],
        fallback: 'timeout',
      },
    ],
    note:
      'Sent to you, not the example member. Nobody is punished and no case is recorded. You ' +
      'appear as the moderator.',
  },

  build(config, scene) {
    const kind = readChoice(scene.inputs, 'kind', PUNISH_KINDS, 'timeout');
    const durationMs = punishedDuration(config, kind);

    const rendered = renderPunishmentNotice(
      config.punish.notifications.messages[kind],
      {
        direction: kind,
        reason: defaultReason(config, kind) ?? config.punish.reasons[0]?.reason ?? null,
        durationMs,
        expiresAt: durationMs === null ? null : scene.now + durationMs,
        expired: false,
        caseId: syntheticId(scene, 'case'),
        user: scene.subject.user,
        moderator: scene.actor.user,
        server: scene.server,
        bot: scene.bot,
      },
      scene.now,
    );

    return delivered(
      silenced(rendered),
      `${scene.subject.displayName} ${PUNISHMENT_ACTIONS[kind]} in ${serverName(scene)}`,
    );
  },
};

const UNPUNISHED_SIMULATION: SimulationAdapter<ModerationConfig> = {
  descriptor: {
    id: UNPUNISHED_SURFACE.id,
    moduleId: MODULE_ID,
    label: 'Punishment lifted message',
    summary: 'The DM a member gets when a ban, timeout or warning is lifted or runs out.',
    surfaceId: UNPUNISHED_SURFACE.id,
    configPath: 'punish.notifications.messages',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [
      {
        key: 'kind',
        label: 'Lifted',
        kind: 'choice',
        options: [
          { value: 'unban', label: 'Unban' },
          { value: 'untimeout', label: 'Timeout ended' },
          { value: 'unwarn', label: 'Warning withdrawn' },
        ],
        fallback: 'untimeout',
      },
      {
        key: 'expired',
        label: 'Ran out on its own',
        help: 'On: a timeout or temporary ban that ended by itself, with Proton as the moderator. Warnings never run out.',
        kind: 'boolean',
        fallback: false,
      },
    ],
    note:
      'Sent to you, not the example member. Nothing is lifted and no case changes. You appear as ' +
      'the moderator.',
  },

  build(config, scene) {
    const kind = readChoice(scene.inputs, 'kind', UNPUNISH_KINDS, 'untimeout');
    const expired = kind !== 'unwarn' && readBoolean(scene.inputs, 'expired', false);
    const endedTimeout = expired && kind === 'untimeout';

    const rendered = renderPunishmentNotice(
      config.punish.notifications.messages[kind],
      {
        direction: kind,
        reason: kind !== 'unwarn' && expired ? EXPIRED_REASONS[kind] : defaultReason(config, kind),
        durationMs: endedTimeout
          ? (durationOf(config.punish.types.timeout.defaultDuration) ?? HOUR)
          : null,
        expiresAt: endedTimeout ? scene.now : null,
        expired,
        caseId: syntheticId(scene, 'case'),
        user: scene.subject.user,
        moderator: expired ? PROTON_MODERATOR : scene.actor.user,
        server: scene.server,
        bot: scene.bot,
      },
      scene.now,
    );

    return delivered(
      silenced(rendered),
      `${scene.subject.displayName} ${PUNISHMENT_ACTIONS[kind]} in ${serverName(scene)}`,
    );
  },
};

function isAlert(action: AutomationAction): action is AlertAction {
  return action.kind === 'alert';
}

function isDm(action: AutomationAction): action is DmAction {
  return action.kind === 'dm';
}

function picked<A extends AutomationAction>(
  config: ModerationConfig,
  inputs: SimulationScene['inputs'],
  is: (action: AutomationAction) => action is A,
): Picked<A> | null {
  const ruleIndex = readInteger(inputs, 'ruleIndex', 0);
  const rule = config.reports.automation[ruleIndex];
  if (rule === undefined) return null;

  const asked = readInteger(inputs, 'actionIndex', 0);
  const named = rule.actions[asked];
  const actionIndex = named !== undefined && is(named) ? asked : rule.actions.findIndex(is);
  const action = rule.actions[actionIndex];

  return action !== undefined && is(action) ? { rule, ruleIndex, action, actionIndex } : null;
}

function withRolePings(message: StaffMessage, roleIds: readonly string[]): ProtonMessage {
  if (roleIds.length === 0) return message;

  const pings = roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
  if (message.v2.length > 0) {
    return { ...message, v2: [{ kind: 'text', content: pings }, ...message.v2] };
  }

  const content = message.content ? `${pings}\n${message.content}` : pings;
  return { ...message, content: clipGraphemes(content, MESSAGE_CONTENT_MAX) };
}

const REPORT_ALERT_SIMULATION: SimulationAdapter<ModerationConfig> = {
  descriptor: {
    id: REPORT_ALERT_SURFACE.id,
    moduleId: MODULE_ID,
    label: 'Automation alert',
    summary: 'The message a report automation rule posts for staff when its conditions are met.',
    surfaceId: REPORT_ALERT_SURFACE.id,
    configPath: 'reports.automation.*.actions.*.message',
    output: 'message',
    delivery: 'channel',
    channelPath: 'reports.automation.*.actions.*.channelId',
    subject: true,
    inputs: RULE_INPUTS,
    note:
      'No report is filed and the rule doesn’t run. Report counts are the lowest the rule’s ' +
      'conditions allow, and the example member is the one reported.',
  },

  destination(config, inputs) {
    const pick = picked(config, inputs, isAlert);
    return pick?.action.channelId ?? config.reports.channelId ?? null;
  },

  build(config, scene) {
    const pick = picked(config, scene.inputs, isAlert);
    if (pick === null) return refuse(NO_ALERT);

    const stage = staged(config, scene, { resolved: false, withMessage: false });
    const { reports, reporters } = pick.rule.conditions;
    const reporterCount = reporters ?? 1;

    const rendered = renderReportAlert(
      pick.action.message,
      {
        ruleName: pick.rule.name,
        report: {
          id: stage.reportId,
          number: stage.number,
          status: 'open',
          method: 'user_menu',
          reason: config.reports.reasons[0]?.label ?? null,
          createdAt: stage.filedAt,
          messageUrl: null,
          url: null,
        },
        totalReports: Math.max(reports ?? 0, reporterCount),
        reporterCount,
        target: scene.subject.user,
        server: scene.server,
        bot: scene.bot,
      },
      scene.now,
      automationMessagePath(pick.ruleIndex, pick.actionIndex),
    );

    const pinged: MessageRender<ProtonMessage> = rendered.ok
      ? {
          ...rendered,
          message: withRolePings(
            rendered.message,
            rendered.message.mentions.roles ? pick.action.roleIds : [],
          ),
        }
      : rendered;

    return delivered(pinged, `${pick.rule.name}, about ${scene.subject.displayName}`);
  },
};

const REPORT_MEMBER_NOTICE_SIMULATION: SimulationAdapter<ModerationConfig> = {
  descriptor: {
    id: REPORT_MEMBER_NOTICE_SURFACE.id,
    moduleId: MODULE_ID,
    label: 'Automation message to the member',
    summary: 'The DM a report automation rule sends to the reported member.',
    surfaceId: REPORT_MEMBER_NOTICE_SURFACE.id,
    configPath: 'reports.automation.*.actions.*.message',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: RULE_INPUTS,
    note:
      'Sent to you, not the example member, and the rule doesn’t run. The member is never told ' +
      'who reported them or what the reports say.',
  },

  build(config, scene) {
    const pick = picked(config, scene.inputs, isDm);
    if (pick === null) return refuse(NO_NOTICE);

    const rendered = renderMemberNotice(
      pick.action.message,
      {
        ruleName: pick.rule.name,
        user: scene.subject.user,
        server: scene.server,
        bot: scene.bot,
      },
      scene.now,
      automationMessagePath(pick.ruleIndex, pick.actionIndex),
    );

    return delivered(silenced(rendered), `${pick.rule.name}, to ${scene.subject.displayName}`);
  },
};

export const moderationSimulations: SimulationAdapter<ModerationConfig>[] = [
  REPORT_CARD_SIMULATION,
  reporterNotice('submitted'),
  reporterNotice('accepted'),
  reporterNotice('dismissed'),
  REPORT_ALERT_SIMULATION,
  REPORT_MEMBER_NOTICE_SIMULATION,
  PUNISHED_SIMULATION,
  UNPUNISHED_SIMULATION,
];
