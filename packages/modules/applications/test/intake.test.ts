import { describe, expect, test } from 'bun:test';
import { SAMPLE_SERVER } from '@proton/core/placeholders';
import type { z } from 'zod';
import { CLOSED_DEFAULT, type FormConfig, formSchema } from '../src/config.ts';
import { type IntakeState, intakeSentence, intakeState, whoCanRead } from '../src/intake.ts';

const NOW = Date.UTC(2026, 8, 24, 12);
const HOUR = 60 * 60 * 1000;
const CHANNEL = '300000000000000001';

function form(overrides: Partial<z.input<typeof formSchema>> = {}): FormConfig {
  return formSchema.parse({ id: 'mods', name: 'Moderator Application', ...overrides });
}

const OPEN = { open: true };

function state(
  intake: z.input<typeof formSchema>['intake'],
  extra: {
    moduleOn?: boolean;
    published?: boolean;
    submittedCount?: number;
    archived?: boolean;
  } = {},
  now = NOW,
): IntakeState {
  return intakeState({
    moduleOn: extra.moduleOn ?? true,
    form: form({ intake, archived: extra.archived ?? false }),
    published: extra.published ?? true,
    submittedCount: extra.submittedCount,
    now,
  });
}

describe('intakeState', () => {
  test('an open, published form with no window takes applications', () => {
    expect(state(OPEN)).toEqual({ state: 'open' });
  });

  test('the reasons it is closed come in a fixed order', () => {
    expect(state(OPEN, { moduleOn: false, archived: true, published: false })).toEqual({
      state: 'closed',
      reason: 'module_off',
    });
    expect(state(OPEN, { archived: true, published: false })).toEqual({
      state: 'closed',
      reason: 'archived',
    });
    expect(state({ open: false }, { published: false })).toEqual({
      state: 'closed',
      reason: 'not_published',
    });
    expect(state({ open: false })).toEqual({ state: 'closed', reason: 'closed' });
  });

  test('a scheduled window opens and closes on time', () => {
    const intake = { open: true, opensAt: NOW + HOUR, closesAt: NOW + 5 * HOUR };

    expect(state(intake, {}, NOW)).toEqual({
      state: 'closed',
      reason: 'not_yet_open',
      opensAt: NOW + HOUR,
      closesAt: NOW + 5 * HOUR,
    });
    expect(state(intake, {}, NOW + HOUR)).toEqual({ state: 'open', closesAt: NOW + 5 * HOUR });
    expect(state(intake, {}, NOW + 5 * HOUR - 1)).toEqual({
      state: 'open',
      closesAt: NOW + 5 * HOUR,
    });
    expect(state(intake, {}, NOW + 5 * HOUR)).toEqual({
      state: 'closed',
      reason: 'deadline_passed',
      closesAt: NOW + 5 * HOUR,
    });
  });

  test('a scheduled window does nothing while the switch is off', () => {
    expect(state({ open: false, opensAt: NOW - HOUR, closesAt: NOW + HOUR })).toEqual({
      state: 'closed',
      reason: 'closed',
    });
  });

  test('a cap closes the form once it is reached, and is ignored when the count is unknown', () => {
    expect(state({ open: true, cap: 10 }, { submittedCount: 9 })).toEqual({ state: 'open' });
    expect(state({ open: true, cap: 10 }, { submittedCount: 10 })).toEqual({
      state: 'closed',
      reason: 'full',
    });
    expect(state({ open: true, cap: 10 })).toEqual({ state: 'open' });
  });
});

describe('intakeSentence', () => {
  const plain = form({ intake: OPEN });

  test('open forms say so, with the deadline when there is one', () => {
    const closesAt = Date.UTC(2026, 9, 1, 18);
    const seconds = closesAt / 1000;

    expect(intakeSentence({ state: 'open' }, plain)).toBe('This form is open for applications.');
    expect(intakeSentence({ state: 'open', closesAt }, plain)).toBe(
      'This form is open for applications until 1 October 2026 at 18:00 UTC.',
    );
    expect(intakeSentence({ state: 'open', closesAt }, plain, { field: 'discord_text' })).toBe(
      `This form is open for applications until <t:${seconds}:f> (<t:${seconds}:R>).`,
    );
  });

  test('each closed reason has its own sentence', () => {
    const closed = (reason: Exclude<IntakeState, { state: 'open' }>['reason'], times = {}) =>
      intakeSentence({ state: 'closed', reason, ...times }, plain);

    expect(closed('module_off')).toBe('Applications are off in this server right now.');
    expect(closed('archived')).toBe('This form is no longer taking applications.');
    expect(closed('not_published')).toBe('This form isn’t open yet.');
    expect(closed('not_yet_open', { opensAt: Date.UTC(2026, 9, 1, 9) })).toBe(
      'This form opens for applications on 1 October 2026 at 09:00 UTC.',
    );
    expect(closed('deadline_passed', { closesAt: Date.UTC(2026, 8, 1, 9) })).toBe(
      'The deadline for this form passed on 1 September 2026 at 09:00 UTC.',
    );
    expect(closed('full')).toBe('This form has received as many applications as it can take.');
    expect(closed('closed')).toBe(CLOSED_DEFAULT);
  });

  test('the closed message is the form’s own, with its placeholders filled in', () => {
    const custom = form({
      messages: { closed: '{application.name} at {server.name} reopens in spring.' },
    });

    expect(
      intakeSentence({ state: 'closed', reason: 'closed' }, custom, { server: SAMPLE_SERVER }),
    ).toBe('Moderator Application at Proton HQ reopens in spring.');
  });

  test('a blank closed message falls back to a plain sentence', () => {
    const blank = form({ messages: { closed: '   ' } });
    expect(intakeSentence({ state: 'closed', reason: 'closed' }, blank)).toBe(
      'This form isn’t taking applications right now.',
    );
  });

  test('a closed message cannot leak staff-only facts', () => {
    const sneaky = form({ messages: { closed: 'Closed. {application.internal_note}' } });
    expect(intakeSentence({ state: 'closed', reason: 'closed' }, sneaky)).toBe('Closed.');
  });
});

describe('whoCanRead', () => {
  test('without a review channel only the review team reads the answers', () => {
    expect(whoCanRead({}, form(), 30)).toBe(
      'Staff who review this form can read your answers. Proton keeps them for 30 days after a decision.',
    );
  });

  test('it discloses what a review card posts in a channel, and to whom', () => {
    expect(whoCanRead({ reviewChannelId: CHANNEL }, form(), 1)).toBe(
      'Staff who review this form can read your answers. A short summary is posted in a staff channel, and anyone who can read that channel can see it. Proton keeps them for 1 day after a decision.',
    );
    expect(whoCanRead({}, form({ review: { channelId: CHANNEL, cardAnswers: 'full' } }), 90)).toBe(
      'Staff who review this form can read your answers. They’re also posted in a staff channel, and anyone who can read that channel can see them. Proton keeps them for 90 days after a decision.',
    );
    expect(
      whoCanRead({ reviewChannelId: CHANNEL }, form({ review: { cardAnswers: 'none' } }), 30),
    ).toBe(
      'Staff who review this form can read your answers. Proton keeps them for 30 days after a decision.',
    );
  });

  test('it never promises the channel is private', () => {
    for (const cardAnswers of ['summary', 'full'] as const) {
      const said = whoCanRead({ reviewChannelId: CHANNEL }, form({ review: { cardAnswers } }), 30);
      expect(said).not.toContain('private');
      expect(said).toContain('anyone who can read that channel');
    }
  });
});
