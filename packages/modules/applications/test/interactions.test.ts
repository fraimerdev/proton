import { describe, expect, test } from 'bun:test';
import { MAX_CUSTOM_ID_LENGTH, newId } from '@proton/core';
import { FORM_ID_MAX, PANEL_ID_MAX } from '../src/constants.ts';
import {
  APPLICANT_ACTION,
  customId,
  isApplicantAction,
  isStaffAction,
  readCustomId,
} from '../src/interface.ts';
import { FRESH_START } from '../src/overview.ts';
import {
  customIdsOf,
  GOOD_ANSWERS,
  GUILD,
  type Harness,
  MEMBER,
  ready,
} from './applicant-harness.ts';

const PANEL_PRESS = customId(APPLICANT_ACTION.open, 'staff', 'mods');

async function withDraft(h: Harness): Promise<void> {
  await h.press(PANEL_PRESS, { panel: true });
  await h.pressButton('Start');
  await h.submitModal(GOOD_ANSWERS);
}

describe('routing presses', () => {
  test('with Applications off a button gets one polite reply and nothing changes', async () => {
    const h = await ready({ config: { enabled: false } });
    const pressed = await h.press(PANEL_PRESS, { panel: true });

    expect(h.callbackTypesFor(pressed.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toEndWith(
      `**Applications** is off in this server, so this button doesn’t work. A server admin can turn it on at <https://prtn.xyz/dashboard/${GUILD}/applications> using the switch at the top of the page.`,
    );
    expect(h.store.applicationsById.size).toBe(0);
  });

  test('turning Applications off between steps refuses the next step without saving it', async () => {
    const h = await ready();
    await h.press(PANEL_PRESS, { panel: true });
    await h.pressButton('Start');
    const before = h.draft();

    h.reconfigure((config) => ({ ...config, enabled: false }));
    const submitted = await h.submitModal(GOOD_ANSWERS);

    expect(h.callbackTypesFor(submitted.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain('**Applications** is off in this server');
    expect(h.draft().revision).toBe(before.revision);
    expect(h.draft().draft).toEqual({});
  });

  test('without its store it answers that the fault is Proton’s and logs what is missing', async () => {
    const h = await ready({ withoutStore: true });
    const pressed = await h.press(PANEL_PRESS, { panel: true });

    expect(h.callbackTypesFor(pressed.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain('This is a fault on my side, not a setting in this server.');
    expect(
      h.logs.some((log) => log.level === 'error' && log.message.includes('without store')),
    ).toBe(true);
  });

  test('presses meant for another module or for nobody are left alone', async () => {
    const h = await ready();
    await h.press('proton:tickets:ot:support:support', { panel: true });
    await h.press('some-other-bot:button', { panel: true });
    await h.submitRaw('proton:appeals:form:x', []);

    expect(h.rest.calls).toEqual([]);
  });

  test('an action this version no longer knows is called out of date', async () => {
    const h = await ready();
    const pressed = await h.press('proton:applications:zz:1');

    expect(h.callbackTypesFor(pressed.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain(
      'This button is out of date. Open the application panel again.',
    );
  });

  test('a store failure before any answer apologises in place and lets the bus retry', async () => {
    const h = await ready();
    h.store.mine = async () => {
      throw new Error('Failed query: select * from applications\nparams: secret answer text');
    };

    await expect(h.press(customId(APPLICANT_ACTION.start, 'mods'))).rejects.toThrow('Failed query');
    const pressed = h.events.at(-1);
    expect(h.callbackTypesFor(pressed?.interactionId ?? '')).toEqual([4]);
    expect(h.lastStatus()).toContain('Something went wrong on my side with this button');
    expect(h.logs.some((log) => log.message.includes('secret answer text'))).toBe(false);
    expect(h.logs.some((log) => log.message.includes('Failed query: select'))).toBe(true);
  });

  test('a store failure after the press was acknowledged apologises with a followup', async () => {
    const h = await ready();
    await h.press(PANEL_PRESS, { panel: true });
    await h.pressButton('Start');
    h.store.saveDraft = async () => {
      throw new Error('connection reset');
    };

    await expect(h.submitModal(GOOD_ANSWERS)).rejects.toThrow('connection reset');
    const submitted = h.events.at(-1);
    const calls = h.callsFor(submitted?.interactionId ?? '');
    expect(h.callbackTypesFor(submitted?.interactionId ?? '')).toEqual([6, 4]);
    expect(h.failures().at(-1)?.result.failure?.discordCode).toBe(40060);
    expect(calls.at(-1)?.method).toBe('POST');
    expect(calls.at(-1)?.path).toStartWith('/webhooks/');
    expect(h.lastStatus()).toContain('Something went wrong on my side with this button');
  });

  test('applicant and staff codes never overlap, so each press has one owner', () => {
    for (const code of Object.values(APPLICANT_ACTION)) {
      expect(isApplicantAction(code)).toBe(true);
      expect(isStaffAction(code)).toBe(false);
    }
  });

  test('a staff code reaches the staff handler, which answers once', async () => {
    const h = await ready();
    await withDraft(h);
    const pressed = await h.press(customId('cl', h.draft().id));

    expect(h.initialCallbacksFor(pressed.interactionId)).toHaveLength(1);
    expect(h.lastStatus() ?? '').not.toContain('This button is out of date');
  });
});

describe('custom ids', () => {
  const longest = {
    panel: 'p'.repeat(PANEL_ID_MAX),
    form: 'f'.repeat(FORM_ID_MAX),
    application: newId(),
    step: '999',
    revision: String(2 ** 31 - 1),
  };

  const ids = [
    customId(APPLICANT_ACTION.open, longest.panel, longest.form),
    customId(APPLICANT_ACTION.openSelect, longest.panel),
    customId(APPLICANT_ACTION.mine),
    customId(APPLICANT_ACTION.start, longest.form, FRESH_START),
    customId(APPLICANT_ACTION.step, longest.application, longest.step),
    customId(APPLICANT_ACTION.answer, longest.application, longest.step, longest.revision),
    customId(APPLICANT_ACTION.review, longest.application, longest.step),
    customId(APPLICANT_ACTION.submit, longest.application, longest.revision),
    customId(APPLICANT_ACTION.later, longest.application),
    customId(APPLICANT_ACTION.cancel, longest.application),
    customId(APPLICANT_ACTION.cancelConfirm, longest.application),
    customId(APPLICANT_ACTION.view, longest.application),
    customId(APPLICANT_ACTION.withdraw, longest.application),
    customId(APPLICANT_ACTION.withdrawConfirm, longest.application),
    customId(APPLICANT_ACTION.respond, longest.application),
    customId(APPLICANT_ACTION.respondModal, longest.application, longest.revision),
  ];

  test.each(ids.map((id) => [id.split(':')[2] ?? '', id] as const))(
    'the longest %s id fits in 100 characters and reads back',
    (_action, id) => {
      expect(id.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
      const parsed = readCustomId(id);
      expect(parsed?.moduleId).toBe('applications');
      expect(parsed?.args.join(':')).toBe(id.split(':').slice(3).join(':'));
    },
  );

  test('every id on every screen of a whole application fits', async () => {
    const h = await ready();
    await withDraft(h);
    await h.pressButton('Continue');
    await h.submitModal({ rules: true });
    await h.pressButton('Review answers');
    await h.pressButton('Submit');
    await h.pressButton('View status');
    await h.press(customId(APPLICANT_ACTION.mine), { panel: true });

    const seen = h
      .facing()
      .flatMap((call) => customIdsOf(h.dataOf(call).components ?? []))
      .filter((id) => id.startsWith('proton:'));
    expect(seen.length).toBeGreaterThan(10);
    for (const id of seen) expect(id.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
    expect([...h.store.applicationsById.values()].map((row) => row.applicantId)).toEqual([MEMBER]);
  });
});
