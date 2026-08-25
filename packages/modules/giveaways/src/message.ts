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
export const LEAVE_ACTION = 'leave';
export const CLAIM_ACTION = 'claim';
export const COUNT_ACTION = 'count';
export const REQUIREMENTS_ACTION = 'requirements';
export const MULTIPLIERS_ACTION = 'multipliers';

export const V2_FLAGS = MESSAGE_FLAG_IS_COMPONENTS_V2;

export type MessageComponent = Record<string, unknown>;

export type ComponentsResult =
  | { ok: true; components: MessageComponent[] }
  | { ok: false; humanReason: string };

export interface GiveawayView {
  id: string;
  shortCode: string | null;
  status: string;
  title: string;
  description: string | null;
  bannerUrl: string | null;
  color: number | null;
  emoji: string | null;
  buttonStyle: number;
  hostId: string;
  winnerCount: number;
  startsAt: Date | null;
  endsAt: Date;
  requirementLogic: 'any' | 'all';
}

export function viewOf(giveaway: Giveaway): GiveawayView {
  return {
    id: giveaway.id,
    shortCode: giveaway.shortCode,
    status: giveaway.status,
    title: giveaway.title,
    description: giveaway.description,
    bannerUrl: giveaway.bannerUrl,
    color: giveaway.color,
    emoji: giveaway.emoji,
    buttonStyle: giveaway.buttonStyle,
    hostId: giveaway.hostId,
    winnerCount: giveaway.winnerCount,
    startsAt: giveaway.startsAt,
    endsAt: giveaway.endsAt,
    requirementLogic: giveaway.requirementLogic,
  };
}

export function text(content: string): MessageComponent {
  return { type: COMPONENT_TEXT_DISPLAY, content };
}

export function separator(): MessageComponent {
  return { type: COMPONENT_SEPARATOR, divider: true, spacing: 1 };
}

export function timestamp(at: Date): string {
  return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
}

export function mentionAll(userIds: readonly string[]): string {
  return userIds.map((userId) => `<@${userId}>`).join(', ');
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function banner(view: GiveawayView): MessageComponent | null {
  if (!view.bannerUrl) return null;

  return { type: COMPONENT_MEDIA_GALLERY, items: [{ media: { url: view.bannerUrl } }] };
}

export function entryStyle(view: GiveawayView): number {
  return (ENTRY_BUTTON_STYLES as readonly number[]).includes(view.buttonStyle)
    ? view.buttonStyle
    : BUTTON_PRIMARY;
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
