import {
  formatDuration,
  isModerationActionKind,
  type ModerationActionKind,
  type ProtonActionExecuted,
  protonActionExecutedSchema,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { channelMention, isSnowflake, type LogLine, logEmbed, userMention } from '../embed.ts';
import type { RenderInput, RenderResult } from './types.ts';

interface ActionLook {
  subject: string;
  action: string;
  colour: number;
  member: boolean;
}

const { Add, Modify, Remove } = ServerLogColors;

const LOOKS: Record<ModerationActionKind, ActionLook> = {
  ban: { subject: 'Member', action: 'banned', colour: Remove, member: true },
  unban: { subject: 'Member', action: 'unbanned', colour: Add, member: true },
  kick: { subject: 'Member', action: 'kicked', colour: Remove, member: true },
  timeout: { subject: 'Member', action: 'timed out', colour: Modify, member: true },
  untimeout: { subject: 'Timeout', action: 'removed', colour: Modify, member: true },
  warn: { subject: 'Member', action: 'warned', colour: Modify, member: true },
  unwarn: { subject: 'Warning', action: 'removed', colour: Add, member: true },
  purge: { subject: 'Messages', action: 'purged', colour: Remove, member: false },
  slowmode: { subject: 'Slowmode', action: 'changed', colour: Modify, member: false },
  lockdown: { subject: 'Channel', action: 'locked', colour: Remove, member: false },
  unlock: { subject: 'Channel', action: 'unlocked', colour: Add, member: false },
};

export const MODULE_LABELS: Readonly<Record<string, string>> = {
  moderation: 'Moderation',
  automod: 'Automod',
  antinuke: 'Anti-Nuke',
  antiraid: 'Anti-Raid',
  honeypot: 'Honeypot',
  phishing: 'Phishing',
  verification: 'Verification',
  appeals: 'Appeals',
  tickets: 'Tickets',
};

export function moduleLabel(moduleId: string): string {
  return MODULE_LABELS[moduleId] ?? moduleId;
}

type ModerationAction = ProtonActionExecuted & { kind: ModerationActionKind };

function moderationActionOf(entity: unknown): ModerationAction | null {
  const parsed = protonActionExecutedSchema.safeParse(entity);
  if (!parsed.success) return null;

  const action = parsed.data;
  return isModerationActionKind(action.kind) ? { ...action, kind: action.kind } : null;
}

function moderatorLine(action: ModerationAction): LogLine {
  if (action.reversal) return { label: 'Moderator', value: 'Ended automatically' };

  if (isSnowflake(action.actorId)) {
    return { label: 'Moderator', mention: userMention(action.actorId), value: action.actorId };
  }

  return { label: 'Moderator', value: `Proton · ${moduleLabel(action.moduleId)}` };
}

function endsAt(action: ModerationAction): number | null {
  if (action.reversal) return null;
  if (action.kind === 'timeout') return action.until ?? action.expiresAt;
  return action.expiresAt;
}

function channelLines(action: ModerationAction): LogLine[] {
  if (!action.channelId) return [];

  const channel = {
    label: 'Channel',
    mention: channelMention(action.channelId),
    value: action.channelId,
  };
  if (action.kind !== 'slowmode' || action.seconds === undefined) return [channel];

  const wait = action.seconds === 0 ? 'Off' : formatDuration(action.seconds * 1000);
  return [channel, { label: 'Slowmode', value: wait }];
}

export function renderModerationAction(input: RenderInput): RenderResult | null {
  const action = moderationActionOf(input.entity);
  if (!action || action.dryRun) return null;

  const look = LOOKS[action.kind];
  const until = endsAt(action);

  const lines: LogLine[] = [
    ...(look.member && action.targetId
      ? [{ label: 'Member', mention: userMention(action.targetId), value: action.targetId }]
      : []),
    ...(look.member ? [] : channelLines(action)),
    ...(until === null ? [] : [{ label: 'Until', mention: `<t:${Math.floor(until / 1000)}:F>` }]),
    moderatorLine(action),
    { label: 'Reason', value: action.reason ?? 'No reason given' },
    { label: 'Case', value: action.caseId },
  ];

  return {
    embed: logEmbed({
      subject: look.subject,
      action: look.action,
      colour: look.colour,
      lines,
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
