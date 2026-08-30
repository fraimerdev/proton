import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { type AppealPanel, appealsConfigSchema } from '../src/config.ts';
import {
  type AppealViewInput,
  appealView,
  checkAnswers,
  DAY_MS,
  type FiledAppeal,
} from '../src/web.ts';

const NOW = 1_700_000_000_000;

function panel(overrides: Partial<AppealPanel> = {}): AppealPanel {
  return {
    id: 'ban',
    name: 'Ban appeal',
    enabled: true,
    blurb: '',
    questions: [
      { key: 'why', label: 'Why should this be lifted?', required: true, maxLength: 1024 },
    ],
    windowDays: 30,
    cooldownDays: 30,
    allowResubmit: false,
    onApprove: 'unban',
    liftBlocklistOnApprove: true,
    approvedMessage: 'Accepted.',
    deniedMessage: 'Turned down.',
    ...overrides,
  };
}

function input(overrides: Partial<AppealViewInput> = {}): AppealViewInput {
  return {
    config: appealsConfigSchema.parse({ enabled: true, panels: [panel()] }),
    panelId: 'ban',
    issuedAt: NOW,
    now: NOW,
    ...overrides,
  };
}

function filed(overrides: Partial<FiledAppeal> = {}): FiledAppeal {
  return { id: 'a1', number: 1, status: 'open', filedAt: NOW, decidedAt: null, ...overrides };
}

describe('a link that is still good', () => {
  test('opens the form', () => {
    const view = appealView(input());

    expect(view.state).toBe('open');
  });
});

describe('a link that is not', () => {
  test('is closed when the server is not taking appeals', () => {
    const view = appealView(
      input({ config: appealsConfigSchema.parse({ enabled: false, panels: [panel()] }) }),
    );

    expect(view).toEqual({
      state: 'closed',
      humanReason: 'This server is not taking appeals at the moment.',
    });
  });

  test('is closed when the form was switched off', () => {
    const view = appealView(
      input({
        config: appealsConfigSchema.parse({ enabled: true, panels: [panel({ enabled: false })] }),
      }),
    );

    expect(view.state).toBe('closed');
  });

  // Nothing the appellant did caused this, and the copy says so.
  test('is closed, and blames nobody, when the form was deleted', () => {
    const view = appealView(
      input({ config: appealsConfigSchema.parse({ enabled: true, panels: [] }) }),
    );

    expect(view.state).toBe('closed');
    expect('humanReason' in view && view.humanReason).toContain('Nothing you did caused this');
  });

  test('closes the moment the window elapses, not a tick before', () => {
    expect(appealView(input({ now: NOW + 30 * DAY_MS - 1 })).state).toBe('open');
    expect(appealView(input({ now: NOW + 30 * DAY_MS })).state).toBe('closed');
  });

  test('says how long is left on a cooldown', () => {
    const view = appealView(input({ lastDecidedAt: NOW - 10 * DAY_MS }));

    expect(view.state).toBe('closed');
    expect('humanReason' in view && view.humanReason).toContain('in 20 days');
  });
});

// The same link is how a banned member is told what came of their appeal, so an appeal already
// filed outranks every closed reason: a form switched off afterwards must not take the answer away
// from somebody who used the link in time.
describe('a link that has already been used', () => {
  test('shows the appeal as filed while it waits', () => {
    const view = appealView(input({ existing: filed() }));

    expect(view.state).toBe('filed');
    expect('humanReason' in view && view.humanReason).toContain('sent to the moderators');
  });

  test('still shows it after the window has elapsed', () => {
    const view = appealView(input({ existing: filed(), now: NOW + 90 * DAY_MS }));

    expect(view.state).toBe('filed');
  });

  test('still shows it after the form was switched off', () => {
    const view = appealView(
      input({
        existing: filed(),
        config: appealsConfigSchema.parse({ enabled: false, panels: [panel({ enabled: false })] }),
      }),
    );

    expect(view.state).toBe('filed');
  });

  test('shows the outcome once it is decided, in the server’s own words', () => {
    const view = appealView(input({ existing: filed({ status: 'approved', decidedAt: NOW }) }));

    expect(view.state).toBe('decided');
    expect('humanReason' in view && view.humanReason).toBe('Accepted.');
  });

  test('offers another go only when the server allows one and the cooldown has passed', () => {
    const allows = appealsConfigSchema.parse({
      enabled: true,
      panels: [panel({ allowResubmit: true, cooldownDays: 7 })],
    });

    const tooSoon = appealView(
      input({
        config: allows,
        existing: filed({ status: 'denied', decidedAt: NOW }),
        now: NOW + 3 * DAY_MS,
      }),
    );

    const ready = appealView(
      input({
        config: allows,
        existing: filed({ status: 'denied', decidedAt: NOW }),
        now: NOW + 8 * DAY_MS,
      }),
    );

    expect(tooSoon.state === 'decided' && tooSoon.resubmit).toBe(false);
    expect(ready.state === 'decided' && ready.resubmit).toBe(true);
  });

  test('never offers another go after an approval', () => {
    const view = appealView(
      input({
        config: appealsConfigSchema.parse({
          enabled: true,
          panels: [panel({ allowResubmit: true, cooldownDays: 0 })],
        }),
        existing: filed({ status: 'approved', decidedAt: NOW }),
      }),
    );

    expect(view.state === 'decided' && view.resubmit).toBe(false);
  });
});

describe('whatever it is handed', () => {
  test('answers exactly one state, and every closed one carries a sentence', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 120 }),
        fc.option(fc.constantFrom('open', 'approved', 'denied'), { nil: undefined }),
        (enabled, panelOn, days, status) => {
          const view = appealView(
            input({
              config: appealsConfigSchema.parse({
                enabled,
                panels: [panel({ enabled: panelOn })],
              }),
              now: NOW + days * DAY_MS,
              existing: status ? filed({ status, decidedAt: NOW }) : undefined,
            }),
          );

          expect(['open', 'filed', 'decided', 'closed']).toContain(view.state);

          if (view.state !== 'open') {
            expect(view.humanReason.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('the answers a browser sends', () => {
  test('are labelled from the form, never from the browser', () => {
    const checked = checkAnswers(panel(), { why: 'I was hacked' });

    expect(checked).toEqual({
      ok: true,
      answers: [{ key: 'why', label: 'Why should this be lifted?', value: 'I was hacked' }],
    });
  });

  test('a question the form does not ask is dropped', () => {
    const checked = checkAnswers(panel(), { why: 'yes', smuggled: 'ignore me' });

    expect(checked.ok && checked.answers.map((a) => a.key)).toEqual(['why']);
  });

  test('a required question left blank is refused, by name', () => {
    const checked = checkAnswers(panel(), { why: '   ' });

    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.humanReason).toContain('Why should this be lifted?');
  });

  test('an over-long answer is cut to the length the form allows', () => {
    const checked = checkAnswers(
      panel({ questions: [{ key: 'why', label: 'Why', required: true, maxLength: 16 }] }),
      { why: 'x'.repeat(500) },
    );

    expect(checked.ok && checked.answers[0]?.value).toHaveLength(16);
  });

  test('an appeal with nothing in it at all is refused', () => {
    const optional = panel({
      questions: [{ key: 'why', label: 'Why', required: false, maxLength: 100 }],
    });

    expect(checkAnswers(optional, {}).ok).toBe(false);
  });
});
