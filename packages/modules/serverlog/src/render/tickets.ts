import {
  ticketClaimedEventSchema,
  ticketClosedEventSchema,
  ticketDeletedEventSchema,
  ticketOpenedEventSchema,
  ticketReopenedEventSchema,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { channelMention, type LogLine, logEmbed, userMention } from '../embed.ts';
import type { RenderInput, RenderResult } from './types.ts';

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

// Mirrors the actor handling in proton.ts: a pseudo actor is not a snowflake, so mentioning it
// would render as literal text where a name belongs.
function actorLine(label: string, actorId: string): LogLine {
  if (actorId.startsWith('proton:')) {
    return { label, value: actorId.slice('proton:'.length) };
  }

  return { label, mention: userMention(actorId), value: actorId };
}

function ticketLines(payload: { number: number; typeName: string; channelId: string }): LogLine[] {
  return [
    { label: 'Ticket', value: `#${payload.number}` },
    { label: 'Type', value: payload.typeName },
    { label: 'Channel', mention: channelMention(payload.channelId), value: payload.channelId },
  ];
}

function elapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;

  return `${Math.round(seconds / 86_400)}d`;
}

export function renderTicketOpened(input: RenderInput): RenderResult | null {
  const parsed = ticketOpenedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Ticket #${payload.number}`,
      action: 'opened',
      colour: ServerLogColors.Add,
      lines: [
        ...ticketLines(payload),
        actorLine('Raised by', payload.openerId),
        { label: 'Priority', value: PRIORITY_LABELS[payload.priority] ?? payload.priority },
        ...(payload.subject ? [{ label: 'Subject', value: payload.subject }] : []),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderTicketClaimed(input: RenderInput): RenderResult | null {
  const parsed = ticketClaimedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Ticket #${payload.number}`,
      action: 'claimed',
      colour: ServerLogColors.Modify,
      lines: [...ticketLines(payload), actorLine('Claimed by', payload.claimedById)],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderTicketClosed(input: RenderInput): RenderResult | null {
  const parsed = ticketClosedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Ticket #${payload.number}`,
      action: 'closed',
      colour: ServerLogColors.Remove,
      lines: [
        ...ticketLines(payload),
        actorLine('Raised by', payload.openerId),
        actorLine('Closed by', payload.closedById),
        { label: 'Open for', value: elapsed(payload.openedAt, payload.closedAt) },
        { label: 'Messages', value: String(payload.messageCount) },
        { label: 'Reason', value: payload.reason ?? 'No reason given' },
      ],
      ...(payload.transcriptUrl
        ? { fields: [{ name: 'Transcript', value: payload.transcriptUrl }] }
        : {}),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderTicketReopened(input: RenderInput): RenderResult | null {
  const parsed = ticketReopenedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Ticket #${payload.number}`,
      action: 'reopened',
      colour: ServerLogColors.Add,
      lines: [...ticketLines(payload), actorLine('Reopened by', payload.reopenedById)],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderTicketDeleted(input: RenderInput): RenderResult | null {
  const parsed = ticketDeletedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Ticket #${payload.number}`,
      action: 'deleted',
      colour: ServerLogColors.Remove,
      lines: [
        ...ticketLines(payload),
        actorLine('Deleted by', payload.deletedById),
        { label: 'Reason', value: payload.reason ?? 'No reason given' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
