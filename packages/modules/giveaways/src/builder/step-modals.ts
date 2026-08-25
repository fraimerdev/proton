import { encodeCustomId, type Modal, tryParseDuration } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import {
  DESCRIPTION_MAX,
  MAX_ENTRIES_PER_USER_MAX,
  MODULE_ID,
  parseGiveawayDuration,
  TITLE_MAX,
  WINNER_COUNT_MAX,
} from '../config.ts';
import { ENTRY_BUTTON_STYLES } from '../message.ts';
import { formatColour, parseColour } from './modal.ts';
import type { BuilderStep, GiveawayDraft } from './state.ts';

export const STEP_MODAL = 'b:step';

type ModalResult = { ok: true; modal: Modal } | { ok: false; humanReason: string };

function text(
  customId: string,
  label: string,
  options: {
    value?: string | null | undefined;
    placeholder?: string;
    description?: string;
    required?: boolean;
    maxLength?: number;
    paragraph?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    type: ComponentType.Label,
    label,
    ...(options.description ? { description: options.description } : {}),
    component: {
      type: ComponentType.TextInput,
      custom_id: customId,
      style: options.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
      required: options.required === true,
      max_length: options.maxLength ?? 200,
      ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      ...(options.value ? { value: options.value } : {}),
    },
  };
}

/**
 * One modal per step. Each is capped at five components because that is Discord's ceiling for a
 * modal — which is exactly why the builder is stepped in the first place: everything a giveaway
 * can be configured with does not fit in one.
 */
export function stepModal(step: BuilderStep, draft: GiveawayDraft): ModalResult {
  const encoded = encodeCustomId(MODULE_ID, STEP_MODAL, step);
  if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

  switch (step) {
    case 'basics':
      return {
        ok: true,
        modal: {
          customId: encoded.customId,
          title: 'Prize & timing',
          components: [
            text('title', 'Prize', {
              value: draft.title,
              required: true,
              maxLength: TITLE_MAX,
              placeholder: 'Nitro for a month',
            }),
            text('description', 'Description', {
              value: draft.description,
              description: 'Shown under the prize. Optional.',
              maxLength: DESCRIPTION_MAX,
              paragraph: true,
            }),
            text('duration', 'How long it runs', {
              required: true,
              maxLength: 16,
              description: 'A number and a unit — 30m, 12h, 7d.',
              placeholder: '24h',
            }),
            text('startsIn', 'Start later', {
              maxLength: 16,
              description: 'Leave empty to start as soon as you publish.',
              placeholder: '2d',
            }),
          ],
        },
      };

    case 'look':
      return {
        ok: true,
        modal: {
          customId: encoded.customId,
          title: 'Appearance',
          components: [
            text('color', 'Accent colour', {
              value: formatColour(draft.color),
              description: 'A hex code. Leave empty for the server default.',
              placeholder: '#5865F2',
              maxLength: 9,
            }),
            text('emoji', 'Heading emoji', {
              value: draft.emoji,
              description: 'Leave empty for 🎉.',
              maxLength: 32,
            }),
            text('bannerUrl', 'Image URL', {
              value: draft.bannerUrl,
              description: 'Shown under the description. Optional.',
              maxLength: 500,
            }),
            text('buttonStyle', 'Button colour', {
              value: String(draft.buttonStyle),
              description: '1 blurple · 2 grey · 3 green · 4 red',
              maxLength: 1,
            }),
          ],
        },
      };

    case 'winners':
      return {
        ok: true,
        modal: {
          customId: encoded.customId,
          title: 'Winner settings',
          components: [
            text('winnerCount', 'How many winners', {
              value: String(draft.winnerCount),
              required: true,
              maxLength: 3,
            }),
            text('maxEntriesPerUser', 'Most entries one member can hold', {
              value: draft.maxEntriesPerUser === null ? null : String(draft.maxEntriesPerUser),
              description: 'Leave empty for no cap.',
              maxLength: 5,
            }),
            text('claimWindow', 'Claim window', {
              value: draft.claimWindowSeconds === null ? null : `${draft.claimWindowSeconds}s`,
              description: 'Unclaimed prizes are rerolled. Leave empty to skip claiming.',
              placeholder: '24h',
              maxLength: 16,
            }),
            text('winMessage', 'Message sent to winners', {
              value: draft.winMessage,
              description: 'Leave empty for the default.',
              maxLength: 1000,
              paragraph: true,
            }),
          ],
        },
      };

    default:
      return { ok: false, humanReason: 'That step has nothing to fill in.' };
  }
}

export type ApplyResult = { ok: true } | { ok: false; humanReason: string };

function optional(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function applyStepModal(
  step: BuilderStep,
  draft: GiveawayDraft,
  fields: Record<string, string>,
): ApplyResult {
  if (step === 'basics') {
    const title = (fields.title ?? '').trim();
    if (title.length === 0) {
      return { ok: false, humanReason: 'A giveaway needs a prize. Say what is being given away.' };
    }

    const duration = parseGiveawayDuration((fields.duration ?? '').trim());
    if (!duration.ok) return { ok: false, humanReason: duration.humanReason };

    const startsIn = optional(fields.startsIn);
    let startsInMs: number | null = null;

    if (startsIn !== null) {
      const parsed = tryParseDuration(startsIn);
      if (parsed === null) {
        return {
          ok: false,
          humanReason:
            `“${startsIn}” is not a length of time I understand. Give a number followed by ` +
            's, m, h, d or w — or leave it empty to start straight away.',
        };
      }
      startsInMs = parsed;
    }

    draft.title = title;
    draft.description = optional(fields.description);
    draft.durationMs = duration.ms;
    draft.startsInMs = startsInMs;

    return { ok: true };
  }

  if (step === 'look') {
    const colour = optional(fields.color);
    if (colour !== null) {
      const parsed = parseColour(colour);
      if (parsed === null) {
        return {
          ok: false,
          humanReason:
            `“${colour}” is not a colour I can read. Give a hex code like #5865F2, or leave it ` +
            'empty for the server default.',
        };
      }
      draft.color = parsed;
    } else {
      draft.color = null;
    }

    const style = Number((fields.buttonStyle ?? '').trim());
    if ((ENTRY_BUTTON_STYLES as readonly number[]).includes(style)) draft.buttonStyle = style;

    draft.emoji = optional(fields.emoji);
    draft.bannerUrl = optional(fields.bannerUrl);

    return { ok: true };
  }

  if (step === 'winners') {
    const winners = Number((fields.winnerCount ?? '').trim());
    if (!Number.isInteger(winners) || winners < 1 || winners > WINNER_COUNT_MAX) {
      return {
        ok: false,
        humanReason:
          `“${fields.winnerCount}” is not a number of winners I can use. Give a whole number ` +
          `between 1 and ${WINNER_COUNT_MAX}.`,
      };
    }

    const cap = optional(fields.maxEntriesPerUser);
    if (cap !== null) {
      const parsed = Number(cap);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ENTRIES_PER_USER_MAX) {
        return {
          ok: false,
          humanReason:
            `The entry cap has to be a whole number between 1 and ${MAX_ENTRIES_PER_USER_MAX}, ` +
            'or empty for no cap.',
        };
      }
      draft.maxEntriesPerUser = parsed;
    } else {
      draft.maxEntriesPerUser = null;
    }

    const claim = optional(fields.claimWindow);
    if (claim !== null) {
      const parsed = tryParseDuration(claim);
      if (parsed === null || parsed < 60_000) {
        return {
          ok: false,
          humanReason:
            `“${claim}” is not a claim window I can use. Give at least a minute — for example ` +
            '24h — or leave it empty so winners keep their prize without claiming.',
        };
      }
      draft.claimWindowSeconds = Math.floor(parsed / 1000);
    } else {
      draft.claimWindowSeconds = null;
    }

    draft.winnerCount = winners;
    draft.winMessage = optional(fields.winMessage);

    return { ok: true };
  }

  return { ok: false, humanReason: 'That step has nothing to fill in.' };
}
