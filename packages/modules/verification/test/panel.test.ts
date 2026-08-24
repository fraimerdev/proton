import { describe, expect, test } from 'bun:test';
import { parseCustomId } from '@proton/core';
import { ButtonStyle, ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { verificationDefaultConfig } from '../src/config.ts';
import {
  ANSWER_ACTION,
  buildCaptchaMessage,
  buildCaptchaModal,
  buildPanelMessage,
  buildWebsiteMessage,
  CAPTCHA_ACTION,
  CAPTCHA_MODAL_TITLE,
  CODE_FIELD,
  describeAttempts,
  REFRESH_ACTION,
  VERIFY_ACTION,
} from '../src/panel.ts';

const CHALLENGE = '01k5f8w9v0000000000000000';

function row(components: Record<string, unknown>[] | undefined): Record<string, unknown>[] {
  const first = components?.[0];
  const inner = first?.components;

  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
}

describe('the panel message', () => {
  test('carries the guild’s own copy and its own button label', () => {
    const built = buildPanelMessage({
      ...verificationDefaultConfig,
      panelTitle: 'Members only',
      panelBody: 'Press below.',
      panelButtonLabel: 'Let me in',
    });

    if (!built.ok) throw new Error(built.humanReason);
    expect(built.content).toBe('## Members only\n\nPress below.');
    expect(row(built.components)[0]?.label).toBe('Let me in');
  });

  test('the button names the module and the action and nothing else, so a press re-reads config', () => {
    const built = buildPanelMessage(verificationDefaultConfig);

    if (!built.ok) throw new Error(built.humanReason);
    const parsed = parseCustomId(row(built.components)[0]?.custom_id);

    expect(parsed).toEqual({ moduleId: 'verification', action: VERIFY_ACTION, args: [] });
  });
});

describe('the captcha message', () => {
  test('offers answering and redrawing, both pinned to the challenge they were built for', () => {
    const built = buildCaptchaMessage(CHALLENGE, 2);

    if (!built.ok) throw new Error(built.humanReason);
    const [answer, refresh] = row(built.components);

    expect(answer?.label).toBe('Enter code');
    expect(parseCustomId(answer?.custom_id)).toEqual({
      moduleId: 'verification',
      action: CAPTCHA_ACTION,
      args: [CHALLENGE],
    });

    expect(refresh?.label).toBe('Different image');
    expect(parseCustomId(refresh?.custom_id)).toEqual({
      moduleId: 'verification',
      action: REFRESH_ACTION,
      args: [CHALLENGE],
    });
  });

  test('says the answer is not case sensitive, because the comparison is not', () => {
    const built = buildCaptchaMessage(CHALLENGE, 1);

    if (!built.ok) throw new Error(built.humanReason);
    expect(built.content).toContain('not case sensitive');
  });

  test('refuses to build a message whose custom_id would not fit Discord', () => {
    const built = buildCaptchaMessage('c'.repeat(200), 1);

    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('unreachable');
    expect(built.humanReason).toContain('Discord allows');
  });
});

describe('describeAttempts', () => {
  test('counts down in words a member reads, and warns on the last one', () => {
    expect(describeAttempts(3)).toBe('You have 3 more attempts after this one.');
    expect(describeAttempts(1)).toBe('You have one more attempt after this one.');
    expect(describeAttempts(0)).toBe('This is your last attempt.');
    expect(describeAttempts(-1)).toBe('This is your last attempt.');
  });
});

describe('the captcha modal', () => {
  test('wraps its input in a Label, which is how Discord carries a modal field', () => {
    const modal = buildCaptchaModal(CHALLENGE, 6);
    if (!modal) throw new Error('the modal did not build');

    const label = modal.components[0] as Record<string, unknown> | undefined;
    const input = label?.component as Record<string, unknown> | undefined;

    expect(modal.title).toBe(CAPTCHA_MODAL_TITLE);
    expect(label?.type).toBe(ComponentType.Label);
    expect(input?.type).toBe(ComponentType.TextInput);
    expect(input?.style).toBe(TextInputStyle.Short);
    expect(input?.custom_id).toBe(CODE_FIELD);
  });

  test('pins the field to the length of the answer, so a typo cannot be submitted', () => {
    const modal = buildCaptchaModal(CHALLENGE, 8);
    if (!modal) throw new Error('the modal did not build');

    const input = (modal.components[0] as Record<string, unknown>).component as Record<
      string,
      unknown
    >;

    expect(input.min_length).toBe(8);
    expect(input.max_length).toBe(8);
    expect(input.required).toBe(true);
  });

  test('carries the challenge id, so an answer to a replaced challenge is recognisable', () => {
    const modal = buildCaptchaModal(CHALLENGE, 6);
    if (!modal) throw new Error('the modal did not build');

    expect(parseCustomId(modal.customId)).toEqual({
      moduleId: 'verification',
      action: ANSWER_ACTION,
      args: [CHALLENGE],
    });
  });

  test('builds nothing rather than a modal Discord would reject', () => {
    expect(buildCaptchaModal('c'.repeat(200), 6)).toBeNull();
  });
});

describe('the website message', () => {
  test('is a link button — it never comes back to Proton, the dashboard finishes the flow', () => {
    const built = buildWebsiteMessage('https://proton.test/verify/token', 'Verify');
    const button = row(built.components)[0];

    expect(button?.style).toBe(ButtonStyle.Link);
    expect(button?.url).toBe('https://proton.test/verify/token');
    expect(button?.custom_id).toBeUndefined();
  });

  test('warns that the link is personal and short-lived', () => {
    const built = buildWebsiteMessage('https://proton.test/verify/token', 'Verify');

    expect(built.content).toContain('yours alone');
    expect(built.content).toContain('15 minutes');
  });
});
