import {
  giveawayBonusGrantedEventSchema,
  giveawayCancelledEventSchema,
  giveawayCreatedEventSchema,
  giveawayEditedEventSchema,
  giveawayEndedEventSchema,
  giveawayPausedEventSchema,
  giveawayRerolledEventSchema,
  giveawayResumedEventSchema,
  giveawayStartedEventSchema,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { channelMention, type LogLine, logEmbed, userMention } from '../embed.ts';
import type { RenderInput, RenderResult } from './types.ts';

// Mirrors the actor handling in proton.ts and tickets.ts: a pseudo actor like `proton:schedule` is
// not a snowflake, so mentioning it would render as literal text where a name belongs.
function actorLine(label: string, actorId: string): LogLine {
  if (actorId.startsWith('proton:')) {
    return { label, value: actorId.slice('proton:'.length) };
  }

  return { label, mention: userMention(actorId), value: actorId };
}

function subjectLines(payload: {
  title: string;
  shortCode: string | null;
  channelId: string;
}): LogLine[] {
  return [
    { label: 'Prize', value: payload.title },
    ...(payload.shortCode === null ? [] : [{ label: 'Code', value: `G-${payload.shortCode}` }]),
    { label: 'Channel', mention: channelMention(payload.channelId), value: payload.channelId },
  ];
}

function winnerLine(winnerIds: readonly string[]): LogLine {
  if (winnerIds.length === 0) return { label: 'Winners', value: 'nobody eligible' };

  return {
    label: winnerIds.length === 1 ? 'Winner' : 'Winners',
    value: winnerIds.map((id) => `<@${id}>`).join(', '),
  };
}

function relative(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

// Compound rather than rounded to one unit: the time held is exactly how far the deadline moved,
// so reporting 90 minutes as "2h" misstates the thing this line exists to report.
function held(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const parts = [
    [Math.floor(seconds / 86_400), 'd'],
    [Math.floor((seconds % 86_400) / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'm'],
  ] as const;

  return parts
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value}${unit}`)
    .join(' ');
}

export function renderGiveawayCreated(input: RenderInput): RenderResult | null {
  const parsed = giveawayCreatedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  const rules = payload.requirementCount + payload.multiplierCount;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'created',
      colour: ServerLogColors.Add,
      lines: [
        ...subjectLines(payload),
        actorLine('Created by', payload.createdById),
        { label: 'Winners', value: String(payload.winnerCount) },
        {
          label: payload.startsAt === null ? 'Ends' : 'Starts',
          value: relative(payload.startsAt ?? payload.endsAt),
        },
        ...(rules === 0
          ? []
          : [
              {
                label: 'Rules',
                value:
                  `${payload.requirementCount} requirement` +
                  `${payload.requirementCount === 1 ? '' : 's'}, ` +
                  `${payload.multiplierCount} multiplier` +
                  `${payload.multiplierCount === 1 ? '' : 's'}`,
              },
            ]),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayStarted(input: RenderInput): RenderResult | null {
  const parsed = giveawayStartedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'started',
      colour: ServerLogColors.Add,
      lines: [...subjectLines(payload), { label: 'Ends', value: relative(payload.endsAt) }],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayEdited(input: RenderInput): RenderResult | null {
  const parsed = giveawayEditedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  const moved =
    payload.endsAtBefore !== null &&
    payload.endsAtAfter !== null &&
    payload.endsAtBefore !== payload.endsAtAfter;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'edited',
      colour: ServerLogColors.Modify,
      lines: [
        ...subjectLines(payload),
        actorLine('Edited by', payload.actorId),
        ...(payload.changed.length === 0
          ? []
          : [{ label: 'Changed', value: payload.changed.join(', ') }]),
        ...(moved && payload.endsAtAfter !== null
          ? [{ label: 'Now ends', value: relative(payload.endsAtAfter) }]
          : []),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayPaused(input: RenderInput): RenderResult | null {
  const parsed = giveawayPausedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'paused',
      colour: ServerLogColors.Modify,
      lines: [
        ...subjectLines(payload),
        actorLine('Paused by', payload.actorId),
        ...(payload.reason === null ? [] : [{ label: 'Reason', value: payload.reason }]),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayResumed(input: RenderInput): RenderResult | null {
  const parsed = giveawayResumedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'resumed',
      colour: ServerLogColors.Add,
      lines: [
        ...subjectLines(payload),
        actorLine('Resumed by', payload.actorId),
        { label: 'Paused for', value: held(payload.heldMs) },
        { label: 'Now ends', value: relative(payload.endsAt) },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayCancelled(input: RenderInput): RenderResult | null {
  const parsed = giveawayCancelledEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'cancelled',
      colour: ServerLogColors.Remove,
      lines: [
        ...subjectLines(payload),
        actorLine('Cancelled by', payload.actorId),
        { label: 'Entrants', value: String(payload.entrantCount) },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

function drawLines(payload: {
  drawNumber: number;
  drawnById: string;
  winnerIds: string[];
  entrantCount: number;
  totalEntries: number;
  disqualified: number;
  degradedProviders: string[];
  seed: string;
}): LogLine[] {
  return [
    winnerLine(payload.winnerIds),
    actorLine('Drawn by', payload.drawnById),
    {
      label: 'Pool',
      value: `${payload.entrantCount} entrants · ${payload.totalEntries} entries`,
    },
    ...(payload.disqualified === 0
      ? []
      : [{ label: 'Disqualified', value: String(payload.disqualified) }]),
    // A draw that ran without one of its requirements is a different draw than the host configured,
    // so it is never silent in the log either.
    ...(payload.degradedProviders.length === 0
      ? []
      : [{ label: 'Skipped rules', value: payload.degradedProviders.join(', ') }]),
    { label: 'Seed', value: `\`${payload.seed}\`` },
  ];
}

export function renderGiveawayEnded(input: RenderInput): RenderResult | null {
  const parsed = giveawayEndedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: payload.winnerIds.length === 0 ? 'ended with no winners' : 'ended',
      colour: payload.winnerIds.length === 0 ? ServerLogColors.Modify : ServerLogColors.Add,
      lines: [...subjectLines(payload), ...drawLines(payload)],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayRerolled(input: RenderInput): RenderResult | null {
  const parsed = giveawayRerolledEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway',
      action: 'rerolled',
      colour: ServerLogColors.Modify,
      lines: [
        ...subjectLines(payload),
        ...(payload.replacedIds.length === 0
          ? []
          : [{ label: 'Replaced', value: payload.replacedIds.map((id) => `<@${id}>`).join(', ') }]),
        ...drawLines(payload),
        { label: 'Draw', value: `#${payload.drawNumber}` },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderGiveawayBonusGranted(input: RenderInput): RenderResult | null {
  const parsed = giveawayBonusGrantedEventSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: 'Giveaway entries',
      action: payload.revoked ? 'taken back' : 'granted',
      colour: payload.revoked ? ServerLogColors.Remove : ServerLogColors.Add,
      lines: [
        ...subjectLines(payload),
        actorLine('Member', payload.subjectId),
        { label: 'Entries', value: `${payload.revoked ? '-' : '+'}${payload.amount}` },
        actorLine(payload.revoked ? 'Taken by' : 'Granted by', payload.actorId),
        ...(payload.reason === null ? [] : [{ label: 'Reason', value: payload.reason }]),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
