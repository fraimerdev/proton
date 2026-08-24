import { encodeCustomId, type Modal } from '@proton/core';
import { ButtonStyle, ComponentType, TextInputStyle } from 'discord-api-types/v10';
import type { VerificationConfig } from './config.ts';
import { MODULE_ID } from './perform.ts';

export const VERIFY_ACTION = 'verify';
export const CAPTCHA_ACTION = 'captcha';
export const REFRESH_ACTION = 'refresh';
export const ANSWER_ACTION = 'answer';

export const CODE_FIELD = 'code';

export const CAPTCHA_MODAL_TITLE = 'Verification';

export type BuiltMessage =
  | { ok: true; content: string; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

function row(...components: Record<string, unknown>[]): Record<string, unknown> {
  return { type: ComponentType.ActionRow, components };
}

export function buildPanelMessage(config: VerificationConfig): BuiltMessage {
  const customId = encodeCustomId(MODULE_ID, VERIFY_ACTION);
  if (!customId.ok) return { ok: false, humanReason: customId.humanReason };

  return {
    ok: true,
    content: `## ${config.panelTitle}\n\n${config.panelBody}`,
    components: [
      row({
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        label: config.panelButtonLabel,
        custom_id: customId.customId,
      }),
    ],
  };
}

export function buildCaptchaMessage(challengeId: string, attemptsLeft: number): BuiltMessage {
  const answer = encodeCustomId(MODULE_ID, CAPTCHA_ACTION, challengeId);
  const refresh = encodeCustomId(MODULE_ID, REFRESH_ACTION, challengeId);

  if (!answer.ok) return { ok: false, humanReason: answer.humanReason };
  if (!refresh.ok) return { ok: false, humanReason: refresh.humanReason };

  return {
    ok: true,
    content:
      'Read the characters in the image and type them in. ' +
      `${describeAttempts(attemptsLeft)}\n\nLetters are not case sensitive.`,
    components: [
      row(
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: 'Enter code',
          custom_id: answer.customId,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: 'Different image',
          custom_id: refresh.customId,
        },
      ),
    ],
  };
}

export function buildWebsiteMessage(
  url: string,
  label: string,
): { content: string; components: Record<string, unknown>[] } {
  return {
    content:
      'Open the link below and sign in with Discord to finish verifying. ' +
      'The link is yours alone and stops working in 15 minutes.',
    components: [
      // A link button carries no custom_id and never comes back to Proton, which is the point: the
      // dashboard finishes the flow and the role arrives while the member is still on the page.
      row({ type: ComponentType.Button, style: ButtonStyle.Link, label, url }),
    ],
  };
}

export function buildCaptchaModal(challengeId: string, length: number): Modal | null {
  const customId = encodeCustomId(MODULE_ID, ANSWER_ACTION, challengeId);
  if (!customId.ok) return null;

  return {
    customId: customId.customId,
    title: CAPTCHA_MODAL_TITLE,
    components: [
      {
        type: ComponentType.Label,
        label: 'The characters in the image',
        component: {
          type: ComponentType.TextInput,
          custom_id: CODE_FIELD,
          style: TextInputStyle.Short,
          required: true,
          min_length: length,
          max_length: length,
        },
      },
    ],
  };
}

export function describeAttempts(attemptsLeft: number): string {
  if (attemptsLeft <= 0) return 'This is your last attempt.';

  return attemptsLeft === 1
    ? 'You have one more attempt after this one.'
    : `You have ${attemptsLeft} more attempts after this one.`;
}
