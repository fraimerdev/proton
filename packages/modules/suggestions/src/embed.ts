import { encodeCustomId } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { MODULE_ID } from './config.ts';
import { type SuggestionStatus, votingOpen } from './decide.ts';

export const VOTE_ACTION = 'vote';

export const VOTE_DIRECTIONS = ['up', 'down'] as const;

export type VoteDirection = (typeof VOTE_DIRECTIONS)[number];

export function isVoteDirection(value: string): value is VoteDirection {
  return (VOTE_DIRECTIONS as readonly string[]).includes(value);
}

export const UP_EMOJI = '👍';
export const DOWN_EMOJI = '👎';

export function emojiFor(direction: VoteDirection): string {
  return direction === 'up' ? UP_EMOJI : DOWN_EMOJI;
}

export const VOTE_VALUES: Record<VoteDirection, 1 | -1> = { up: 1, down: -1 };

export const STATUS_COLOURS: Record<SuggestionStatus, number> = {
  open: 0x58_65_f2,
  accepted: 0x57_f2_87,
  denied: 0xed_42_45,
  implemented: 0x9b_59_b6,
};

export const STATUS_LABELS: Record<SuggestionStatus, string> = {
  open: 'Open',
  accepted: 'Accepted',
  denied: 'Denied',
  implemented: 'Implemented',
};

export const DECIDER_HEADINGS: Record<SuggestionStatus, string> = {
  open: 'Decided by',
  accepted: 'Accepted by',
  denied: 'Denied by',
  implemented: 'Implemented by',
};

export const DESCRIPTION_MAX = 4096;
export const FIELD_VALUE_MAX = 1024;

export type Embed = Record<string, unknown>;
export type MessageComponent = Record<string, unknown>;

export type ComponentsResult =
  | { ok: true; components: MessageComponent[] }
  | { ok: false; humanReason: string };

export interface Tally {
  up: number;
  down: number;
}

export const NO_VOTES: Tally = { up: 0, down: 0 };

export function net(tally: Tally): number {
  return tally.up - tally.down;
}

export function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export interface SuggestionView {
  id: string;
  number: number;
  authorId: string;
  content: string;
  status: SuggestionStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
}

export interface EmbedOptions {
  anonymous: boolean;
}

export function buildSuggestionEmbed(
  view: SuggestionView,
  tally: Tally,
  options: EmbedOptions,
): Embed {
  const attribution = options.anonymous
    ? 'Suggested anonymously.'
    : `Suggested by <@${view.authorId}>`;

  const fields: Array<Record<string, unknown>> = [
    {
      name: 'Votes',
      value:
        `${UP_EMOJI} **${tally.up}** ${DOWN_EMOJI} **${tally.down}**` +
        ` · net **${signed(net(tally))}**`,
      inline: true,
    },
    { name: 'Status', value: STATUS_LABELS[view.status], inline: true },
  ];

  // Built from the row's own decided_by/decision_reason rather than appended to what was there
  // before, so a suggestion decided twice shows the second verdict and only the second.
  if (view.decidedBy !== null && view.status !== 'open') {
    const reason =
      view.decisionReason === null ? '' : `\n> ${view.decisionReason.replaceAll('\n', '\n> ')}`;

    fields.push({
      name: DECIDER_HEADINGS[view.status],
      value: `<@${view.decidedBy}>${reason}`.slice(0, FIELD_VALUE_MAX),
    });
  }

  const embed: Embed = {
    title: `Suggestion #${view.number}`,
    color: STATUS_COLOURS[view.status],
    description: `${view.content}\n\n${attribution}`.slice(0, DESCRIPTION_MAX),
    fields,
  };

  if (view.decidedAt !== null) embed.timestamp = view.decidedAt.toISOString();

  return embed;
}

export function buildVoteRow(suggestionId: string, status: SuggestionStatus): ComponentsResult {
  const buttons: MessageComponent[] = [];

  for (const direction of VOTE_DIRECTIONS) {
    const encoded = encodeCustomId(MODULE_ID, VOTE_ACTION, suggestionId, direction);
    if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

    buttons.push({
      type: ComponentType.Button,
      style: direction === 'up' ? ButtonStyle.Success : ButtonStyle.Danger,
      custom_id: encoded.customId,
      label: direction === 'up' ? 'Upvote' : 'Downvote',
      emoji: { name: emojiFor(direction) },
      ...(votingOpen(status) ? {} : { disabled: true }),
    });
  }

  return { ok: true, components: [{ type: ComponentType.ActionRow, components: buttons }] };
}

export function threadName(view: SuggestionView): string {
  const summary = view.content.replaceAll(/\s+/g, ' ').trim();
  return `Suggestion #${view.number} — ${summary}`.slice(0, 100);
}
