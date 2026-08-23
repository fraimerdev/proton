import { encodeCustomId, MESSAGE_FLAG_IS_COMPONENTS_V2 } from '@proton/core';
import { MODULE_ID, plural } from './config.ts';
import type { Giveaway } from './store.ts';

export const COMPONENT_CONTAINER = 17;
export const COMPONENT_TEXT_DISPLAY = 10;
export const COMPONENT_SEPARATOR = 14;
export const COMPONENT_MEDIA_GALLERY = 12;
export const COMPONENT_ACTION_ROW = 1;
export const COMPONENT_BUTTON = 2;

export const BUTTON_PRIMARY = 1;
export const BUTTON_SECONDARY = 2;
export const BUTTON_SUCCESS = 3;
export const BUTTON_DANGER = 4;

export const ENTRY_BUTTON_STYLES = [
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  BUTTON_DANGER,
] as const;

export const ENTER_ACTION = 'enter';
export const CLAIM_ACTION = 'claim';
export const COUNT_ACTION = 'count';

export const V2_FLAGS = MESSAGE_FLAG_IS_COMPONENTS_V2;

export type MessageComponent = Record<string, unknown>;

export type ComponentsResult =
  | { ok: true; components: MessageComponent[] }
  | { ok: false; humanReason: string };

export interface GiveawayView {
  id: string;
  title: string;
  description: string | null;
  bannerUrl: string | null;
  color: number | null;
  emoji: string | null;
  buttonStyle: number;
  hostId: string;
  winnerCount: number;
  endsAt: Date;
  requirementLogic: 'any' | 'all';
}

export function viewOf(giveaway: Giveaway): GiveawayView {
  return {
    id: giveaway.id,
    title: giveaway.title,
    description: giveaway.description,
    bannerUrl: giveaway.bannerUrl,
    color: giveaway.color,
    emoji: giveaway.emoji,
    buttonStyle: giveaway.buttonStyle,
    hostId: giveaway.hostId,
    winnerCount: giveaway.winnerCount,
    endsAt: giveaway.endsAt,
    requirementLogic: giveaway.requirementLogic,
  };
}

function text(content: string): MessageComponent {
  return { type: COMPONENT_TEXT_DISPLAY, content };
}

function separator(): MessageComponent {
  return { type: COMPONENT_SEPARATOR, divider: true, spacing: 1 };
}

function timestamp(at: Date): string {
  return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
}

export function mentionAll(userIds: readonly string[]): string {
  return userIds.map((userId) => `<@${userId}>`).join(', ');
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export interface RenderInput {
  view: GiveawayView;
  entrantCount: number;
  requirements: readonly string[];
  multipliers: readonly string[];
  accentColor: number;
}

export interface EndedInput extends RenderInput {
  winnerIds: readonly string[];
  cancelled?: boolean;
}

function heading(view: GiveawayView): string {
  return `# ${view.emoji ?? '\u{1F389}'} ${view.title}`;
}

function facts(view: GiveawayView, ended: boolean): string {
  const winners = plural(view.winnerCount, 'winner');

  return ended
    ? `**${winners}** · hosted by <@${view.hostId}>`
    : `Ends ${timestamp(view.endsAt)} · **${winners}** · hosted by <@${view.hostId}>`;
}

function requirementBlock(view: GiveawayView, lines: readonly string[]): MessageComponent | null {
  if (lines.length === 0) return null;

  const note =
    lines.length > 1
      ? view.requirementLogic === 'any'
        ? ' — you need **any one** of these'
        : ' — you need **all** of these'
      : '';

  return text(`**Requirements**${note}\n${lines.map((line) => `• ${line}`).join('\n')}`);
}

function multiplierBlock(lines: readonly string[]): MessageComponent | null {
  if (lines.length === 0) return null;

  return text(`**Bonus entries**\n${lines.map((line) => `• ${line}`).join('\n')}`);
}

function banner(view: GiveawayView): MessageComponent | null {
  if (!view.bannerUrl) return null;

  return { type: COMPONENT_MEDIA_GALLERY, items: [{ media: { url: view.bannerUrl } }] };
}

function entryStyle(view: GiveawayView): number {
  return (ENTRY_BUTTON_STYLES as readonly number[]).includes(view.buttonStyle)
    ? view.buttonStyle
    : BUTTON_PRIMARY;
}

export function buildEntryRow(view: GiveawayView, entrantCount: number): ComponentsResult {
  const enterId = encodeCustomId(MODULE_ID, ENTER_ACTION, view.id);
  if (!enterId.ok) return { ok: false, humanReason: enterId.humanReason };

  const countId = encodeCustomId(MODULE_ID, COUNT_ACTION, view.id);
  if (!countId.ok) return { ok: false, humanReason: countId.humanReason };

  return {
    ok: true,
    components: [
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          {
            type: COMPONENT_BUTTON,
            style: entryStyle(view),
            label: 'Enter giveaway',
            emoji: { name: '\u{1F389}' },
            custom_id: enterId.customId,
          },
          {
            type: COMPONENT_BUTTON,
            style: BUTTON_SECONDARY,
            label: `${entrantCount} ${entrantCount === 1 ? 'entrant' : 'entrants'}`,
            custom_id: countId.customId,
            disabled: true,
          },
        ],
      },
    ],
  };
}

export function claimRow(giveawayId: string, drawNumber: number): ComponentsResult {
  const claimId = encodeCustomId(MODULE_ID, CLAIM_ACTION, giveawayId, String(drawNumber));
  if (!claimId.ok) return { ok: false, humanReason: claimId.humanReason };

  return {
    ok: true,
    components: [
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          {
            type: COMPONENT_BUTTON,
            style: BUTTON_SUCCESS,
            label: 'Claim your prize',
            emoji: { name: '\u{1F381}' },
            custom_id: claimId.customId,
          },
        ],
      },
    ],
  };
}

// The whole message is components: under IS_COMPONENTS_V2 Discord refuses content, embeds,
// sticker_ids and poll outright, so there is no text half to fall back on.
export function runningMessage(input: RenderInput): ComponentsResult {
  const row = buildEntryRow(input.view, input.entrantCount);
  if (!row.ok) return row;

  const body: MessageComponent[] = [text(heading(input.view))];

  if (input.view.description) body.push(text(input.view.description));

  const media = banner(input.view);
  if (media) body.push(media);

  body.push(separator(), text(facts(input.view, false)));

  const requirements = requirementBlock(input.view, input.requirements);
  if (requirements) body.push(requirements);

  const multipliers = multiplierBlock(input.multipliers);
  if (multipliers) body.push(multipliers);

  body.push(separator(), ...row.components);

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

export function endedMessage(input: EndedInput): ComponentsResult {
  const body: MessageComponent[] = [text(heading(input.view))];

  if (input.view.description) body.push(text(input.view.description));

  const media = banner(input.view);
  if (media) body.push(media);

  body.push(separator());

  if (input.cancelled) {
    body.push(text('**This giveaway was cancelled.** Nobody was drawn.'));
  } else if (input.winnerIds.length === 0) {
    body.push(
      text(
        '**Nobody won.** Either nobody entered, or everybody who did stopped meeting the ' +
          'requirements before it was drawn.',
      ),
    );
  } else {
    const label = input.winnerIds.length === 1 ? 'Winner' : 'Winners';
    body.push(text(`**${label}:** ${mentionAll(input.winnerIds)}`));
  }

  body.push(text(`${plural(input.entrantCount, 'entrant')} · hosted by <@${input.view.hostId}>`));

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

export function countedRow(view: GiveawayView, entrantCount: number): ComponentsResult {
  return buildEntryRow(view, entrantCount);
}

export function announcement(
  view: GiveawayView,
  winnerIds: readonly string[],
  link: string,
): string {
  if (winnerIds.length === 0) {
    return `Nobody qualified for **${view.title}**, so it went undrawn. ${link}`;
  }

  return `${mentionAll(winnerIds)} — you won **${view.title}**! ` + `Congratulations. ${link}`;
}

export function rerollAnnouncement(
  view: GiveawayView,
  winnerIds: readonly string[],
  link: string,
): string {
  if (winnerIds.length === 0) {
    return `There was nobody left to reroll for **${view.title}**. ${link}`;
  }

  return `${mentionAll(winnerIds)} — you won the reroll for **${view.title}**! ${link}`;
}

export interface ListEntry {
  view: GiveawayView;
  entrants: number;
}

export function renderList(entries: readonly ListEntry[]): string {
  if (entries.length === 0) {
    return 'There are no giveaways here yet. Start one with `/giveaway create`.';
  }

  return entries
    .map((entry) => {
      const title =
        entry.view.title.length > 60 ? `${entry.view.title.slice(0, 59)}…` : entry.view.title;

      return (
        `• **${title}** — ${plural(entry.entrants, 'entrant')}, ` +
        `${plural(entry.view.winnerCount, 'winner')}, ends ${timestamp(entry.view.endsAt)} ` +
        `(\`${entry.view.id}\`)`
      );
    })
    .join('\n');
}
