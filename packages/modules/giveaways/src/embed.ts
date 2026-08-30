import { encodeCustomId } from '@proton/core';
import { MODULE_ID, plural } from './config.ts';
import {
  BUTTON_SECONDARY,
  banner,
  COMPONENT_ACTION_ROW,
  COMPONENT_BUTTON,
  COMPONENT_CONTAINER,
  type ComponentsResult,
  ENTER_ACTION,
  entryStyle,
  type GiveawayView,
  LEAVE_ACTION,
  type MessageComponent,
  MULTIPLIERS_ACTION,
  REQUIREMENTS_ACTION,
  separator,
  text,
  timestamp,
} from './message.ts';
import { formatShortCode } from './short-code.ts';

export const GIVEAWAY_CARDS = [
  'scheduled',
  'active',
  'drop',
  'paused',
  'drawing',
  'ended',
  'cancelled',
  'no-winners',
  'rerolled',
] as const;

export type GiveawayCard = (typeof GIVEAWAY_CARDS)[number];

export interface CardInput {
  view: GiveawayView;
  entrantCount: number;
  requirements: readonly string[];
  multipliers: readonly string[];
  accentColor: number;
  winnerIds?: readonly string[];
  pausedBy?: string | null;
  pauseReason?: string | null;
}

const MEDAL = ['\u{1F947}', '\u{1F948}', '\u{1F949}'] as const;

function heading(view: GiveawayView): MessageComponent {
  return text(`# ${view.emoji ?? '\u{1F389}'} ${view.title}`);
}

function field(label: string, value: string): string {
  return `${label}\n${value}`;
}

/**
 * The scannable block the whole card hangs off. Kept as one TextDisplay rather than one per fact:
 * a Container counts every child against the 40-component budget, and a giveaway with a banner,
 * requirements, multipliers and two button rows has no slots to spare on formatting.
 */
function facts(input: CardInput, when: string | null): MessageComponent {
  const lines = [
    field('\u{1F3C6} **Winners**', String(input.view.winnerCount)),
    ...(when === null ? [] : [field('⏰ **Ends**', when)]),
    field('\u{1F3AB} **Entries**', input.entrantCount.toLocaleString('en-GB')),
    field('\u{1F464} **Hosted by**', `<@${input.view.hostId}>`),
  ];

  return text(lines.join('\n\n'));
}

function requirementBlock(input: CardInput): MessageComponent | null {
  if (input.requirements.length === 0) return null;

  const note =
    input.requirements.length > 1
      ? input.view.requirementLogic === 'any'
        ? ' — you need **any one** of these'
        : ' — you need **all** of these'
      : '';

  return text(
    `✨ **Requirements**${note}\n${input.requirements.map((line) => `✅ ${line}`).join('\n')}`,
  );
}

function multiplierBlock(input: CardInput): MessageComponent | null {
  if (input.multipliers.length === 0) return null;

  return text(`✨ **Bonus entries**\n${input.multipliers.map((line) => `✖️ ${line}`).join('\n')}`);
}

function footer(view: GiveawayView): MessageComponent {
  const code = formatShortCode(view.shortCode);
  return text(`-# ${code === null ? view.id : code}`);
}

function winnerList(winnerIds: readonly string[]): string {
  return winnerIds.map((userId, index) => `${MEDAL[index] ?? '\u{1F3C5}'} <@${userId}>`).join('\n');
}

function button(
  style: number,
  label: string,
  emoji: string,
  customId: string,
  disabled = false,
): MessageComponent {
  return {
    type: COMPONENT_BUTTON,
    style,
    label,
    emoji: { name: emoji },
    custom_id: customId,
    ...(disabled ? { disabled: true } : {}),
  };
}

/**
 * Entry controls. `live` false renders the same row disabled rather than dropping it, so a paused
 * giveaway still reads as a giveaway instead of losing its shape mid-run.
 */
function entryRows(input: CardInput, live: boolean): ComponentsResult {
  const ids = {
    enter: encodeCustomId(MODULE_ID, ENTER_ACTION, input.view.id),
    leave: encodeCustomId(MODULE_ID, LEAVE_ACTION, input.view.id),
    requirements: encodeCustomId(MODULE_ID, REQUIREMENTS_ACTION, input.view.id),
    multipliers: encodeCustomId(MODULE_ID, MULTIPLIERS_ACTION, input.view.id),
  };

  for (const id of Object.values(ids)) {
    if (!id.ok) return { ok: false, humanReason: id.humanReason };
  }

  if (!ids.enter.ok || !ids.leave.ok || !ids.requirements.ok || !ids.multipliers.ok) {
    return { ok: false, humanReason: 'a giveaway button id could not be built' };
  }

  const rows: MessageComponent[] = [
    {
      type: COMPONENT_ACTION_ROW,
      components: [
        button(entryStyle(input.view), 'Enter giveaway', '\u{1F389}', ids.enter.customId, !live),
        button(BUTTON_SECONDARY, 'Leave', '\u{1F6AA}', ids.leave.customId, !live),
      ],
    },
  ];

  const detail: MessageComponent[] = [];
  if (input.requirements.length > 0) {
    detail.push(button(BUTTON_SECONDARY, 'Requirements', '\u{1F4CB}', ids.requirements.customId));
  }
  if (input.multipliers.length > 0) {
    detail.push(button(BUTTON_SECONDARY, 'Bonus entries', '✨', ids.multipliers.customId));
  }

  if (detail.length > 0) rows.push({ type: COMPONENT_ACTION_ROW, components: detail });

  return { ok: true, components: rows };
}

function container(input: CardInput, body: MessageComponent[]): ComponentsResult {
  return {
    ok: true,
    components: [
      {
        type: COMPONENT_CONTAINER,
        accent_color: input.view.color ?? input.accentColor,
        components: body,
      },
    ],
  };
}

function opening(input: CardInput): MessageComponent[] {
  const body: MessageComponent[] = [heading(input.view)];

  if (input.view.description) body.push(text(input.view.description));

  const media = banner(input.view);
  if (media) body.push(media);

  body.push(separator());
  return body;
}

export function buildScheduled(input: CardInput): ComponentsResult {
  const body = opening(input);
  const startsAt = input.view.startsAt;

  body.push(
    text(
      `\u{1F5D3}️ **Starts ${startsAt === null ? 'soon' : timestamp(startsAt)}**\n` +
        'Entries open when it starts.',
    ),
    facts(input, timestamp(input.view.endsAt)),
  );

  const requirements = requirementBlock(input);
  if (requirements) body.push(requirements);

  const multipliers = multiplierBlock(input);
  if (multipliers) body.push(multipliers);

  const rows = entryRows(input, false);
  if (!rows.ok) return rows;

  body.push(separator(), ...rows.components, footer(input.view));

  return container(input, body);
}

export function buildActive(input: CardInput): ComponentsResult {
  const body = opening(input);
  body.push(facts(input, timestamp(input.view.endsAt)));

  const requirements = requirementBlock(input);
  if (requirements) body.push(requirements);

  const multipliers = multiplierBlock(input);
  if (multipliers) body.push(multipliers);

  const rows = entryRows(input, true);
  if (!rows.ok) return rows;

  body.push(separator(), ...rows.components, footer(input.view));

  return container(input, body);
}

/**
 * A drop has no countdown and no entrant count — there is nothing to count down to and nobody is
 * entered. It is won by pressing first, so the card says that and nothing else.
 */
export function buildDrop(input: CardInput): ComponentsResult {
  const body = opening(input);

  body.push(
    text('\u{1F381} **DROP**\nFirst eligible member to press it wins. No draw, no waiting.'),
    text(`\u{1F464} **Hosted by**\n<@${input.view.hostId}>`),
  );

  const requirements = requirementBlock(input);
  if (requirements) body.push(requirements);

  const rows = entryRows(input, true);
  if (!rows.ok) return rows;

  body.push(separator(), ...rows.components, footer(input.view));

  return container(input, body);
}

export function buildPaused(input: CardInput): ComponentsResult {
  const body = opening(input);

  const because = input.pauseReason ? `\n${input.pauseReason}` : '';
  body.push(
    text(
      `⏸️ **Paused**\nEntries are closed for now. The time remaining is held where it ` +
        `was, so nobody loses out.${because}`,
    ),
    // No end timestamp while paused: ends_at is still the pre-pause instant and would count down
    // to a deadline that is not going to happen.
    facts(input, null),
  );

  const requirements = requirementBlock(input);
  if (requirements) body.push(requirements);

  const rows = entryRows(input, false);
  if (!rows.ok) return rows;

  body.push(separator(), ...rows.components, footer(input.view));

  return container(input, body);
}

export function buildDrawing(input: CardInput): ComponentsResult {
  const body = opening(input);

  body.push(
    text('\u{1F3B2} **Drawing now**\nEntries are closed. The winners are being picked.'),
    facts(input, null),
  );

  const rows = entryRows(input, false);
  if (!rows.ok) return rows;

  body.push(separator(), ...rows.components, footer(input.view));

  return container(input, body);
}

export function buildEnded(input: CardInput): ComponentsResult {
  const winnerIds = input.winnerIds ?? [];
  if (winnerIds.length === 0) return buildNoWinners(input);

  const body = opening(input);

  body.push(
    text(
      `\u{1F3C6} **${winnerIds.length === 1 ? 'Winner' : 'Winners'}**\n${winnerList(winnerIds)}`,
    ),
    text(`\u{1F3AB} ${plural(input.entrantCount, 'entry')} · hosted by <@${input.view.hostId}>`),
  );

  // Requirements stay on the ended card: the first question under a result is always "why them",
  // and stripping the rules turns that into a support ticket.
  const requirements = requirementBlock(input);
  if (requirements) body.push(requirements);

  body.push(footer(input.view));

  return container(input, body);
}

export function buildRerolled(input: CardInput): ComponentsResult {
  const winnerIds = input.winnerIds ?? [];
  if (winnerIds.length === 0) return buildNoWinners(input);

  const body = opening(input);

  body.push(
    text(
      `\u{1F504} **Rerolled — new ${winnerIds.length === 1 ? 'winner' : 'winners'}**\n` +
        winnerList(winnerIds),
    ),
    text(`\u{1F3AB} ${plural(input.entrantCount, 'entry')} · hosted by <@${input.view.hostId}>`),
    footer(input.view),
  );

  return container(input, body);
}

export function buildNoWinners(input: CardInput): ComponentsResult {
  const body = opening(input);

  body.push(
    text(
      '\u{1F614} **Nobody won**\nEither nobody entered, or everybody who did stopped meeting ' +
        'the requirements before it was drawn.',
    ),
    text(`\u{1F3AB} ${plural(input.entrantCount, 'entry')} · hosted by <@${input.view.hostId}>`),
    footer(input.view),
  );

  return container(input, body);
}

export function buildCancelled(input: CardInput): ComponentsResult {
  const body = opening(input);

  body.push(
    text('\u{1F6D1} **Cancelled**\nThis giveaway was called off. Nobody was drawn.'),
    text(`Hosted by <@${input.view.hostId}>`),
    footer(input.view),
  );

  return container(input, body);
}

const BUILDERS: Record<GiveawayCard, (input: CardInput) => ComponentsResult> = {
  scheduled: buildScheduled,
  active: buildActive,
  drop: buildDrop,
  paused: buildPaused,
  drawing: buildDrawing,
  ended: buildEnded,
  cancelled: buildCancelled,
  'no-winners': buildNoWinners,
  rerolled: buildRerolled,
};

export function cardFor(
  status: string,
  winnerIds: readonly string[] = [],
  entryMethod: string = 'button',
): GiveawayCard {
  if (status === 'running' && entryMethod === 'drop') return 'drop';

  switch (status) {
    case 'scheduled':
      return 'scheduled';
    case 'paused':
      return 'paused';
    case 'drawing':
      return 'drawing';
    case 'cancelled':
      return 'cancelled';
    case 'ended':
      return winnerIds.length === 0 ? 'no-winners' : 'ended';
    default:
      return 'active';
  }
}

export function renderCard(card: GiveawayCard, input: CardInput): ComponentsResult {
  return BUILDERS[card](input);
}
