import { describe, expect, test } from 'bun:test';
import {
  answerModal,
  CAPTCHA,
  CAPTCHA_PNG,
  CAPTCHA_TTL_MS,
  captchaPress,
  DM_CHANNEL,
  EVERYONE_ROLE,
  GUILD,
  harness,
  MEMBER,
  refreshPress,
  UNVERIFIED_ROLE,
  VERIFIED_ROLE,
  verifyPress,
} from './harness.ts';

const CODE = 'code';

const CLOSED_DM = {
  status: 403,
  body: { code: 50007, message: 'Cannot send messages to this user' },
};

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe('issuing a captcha', () => {
  test('draws the stored answer and delivers it with the two buttons that answer it', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), { config: CAPTCHA });

    const stored = await h.captcha.get(GUILD, MEMBER);
    expect(outcome).toEqual({ action: 'challenged', challengeId: stored?.challengeId ?? '' });
    expect(h.rendered).toEqual([stored?.answer ?? '']);

    const delivered = h.shown().at(-1);
    expect(delivered?.files).toEqual([{ filename: 'captcha.png', data: CAPTCHA_PNG }]);
    expect(h.buttons().map((button) => button.label)).toEqual(['Enter code', 'Different image']);
  });

  test('the buttons it renders are the ones the handlers answer to', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: CAPTCHA });
    const stored = await h.captcha.get(GUILD, MEMBER);

    expect(h.button('Enter code').customId).toBe(captchaPress(stored?.challengeId ?? ''));
    expect(h.button('Different image').customId).toBe(refreshPress(stored?.challengeId ?? ''));
  });

  test('gives the challenge a deadline rather than letting it sit in Redis forever', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: CAPTCHA });

    expect(h.captcha.expiryOf(GUILD, MEMBER)).toBe(h.now() + CAPTCHA_TTL_MS);

    h.advance(CAPTCHA_TTL_MS);
    expect(await h.captcha.get(GUILD, MEMBER)).toBeNull();
  });

  test('refuses the gate before drawing anything Proton could not reward', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), { config: { enabled: true, mode: 'captcha' } });

    expect(outcome.action).toBe('refused');
    expect(h.rendered).toEqual([]);
    expect(await h.captcha.get(GUILD, MEMBER)).toBeNull();
  });

  test('says so, and stores nothing, when the image cannot be drawn', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), {
      config: CAPTCHA,
      deps: {
        ...h.deps,
        renderCaptcha: async () => {
          throw new Error('no fonts');
        },
      },
    });

    expect(outcome.action).toBe('refused');
    expect(h.lastTold()).toContain('could not draw your captcha');
    expect(await h.captcha.get(GUILD, MEMBER)).toBeNull();
  });

  test('a second press replaces the first challenge instead of stacking one on it', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: CAPTCHA });
    const first = await h.captcha.get(GUILD, MEMBER);
    await h.press(verifyPress(), { config: CAPTCHA });
    const second = await h.captcha.get(GUILD, MEMBER);

    expect(second?.challengeId).not.toBe(first?.challengeId);
    expect(h.captcha.entries.size).toBe(1);
  });
});

describe('the Enter code press', () => {
  test('opens a modal as its one and only response — a modal cannot follow a defer', async () => {
    const h = harness();
    const challenge = await h.seed();

    const outcome = await h.press(captchaPress(challenge.challengeId), { config: CAPTCHA });

    expect(outcome).toEqual({ action: 'challenged', challengeId: challenge.challengeId });
    expect(h.callbackTypes()).toEqual([9]);
    expect(h.modalOpened()?.custom_id).toBe(answerModal(challenge.challengeId));
  });

  test('asks for exactly as many characters as the image shows', async () => {
    const h = harness();
    const challenge = await h.seed({ length: 8 });

    await h.press(captchaPress(challenge.challengeId), { config: CAPTCHA });

    const label = (h.modalOpened()?.components as Record<string, unknown>[] | undefined)?.[0];
    const input = label?.component as Record<string, unknown> | undefined;

    expect(input?.custom_id).toBe(CODE);
    expect(input?.min_length).toBe(8);
    expect(input?.max_length).toBe(8);
  });

  test('refuses a challenge that has been replaced, without opening a modal', async () => {
    const h = harness();
    const stale = await h.seed();
    await h.seed();

    const outcome = await h.press(captchaPress(stale.challengeId), { config: CAPTCHA });

    expect(outcome.action).toBe('refused');
    expect(h.callbackTypes()).toEqual([4]);
    expect(h.lastTold()).toContain('expired or been replaced');
  });
});

describe('answering the captcha', () => {
  test('a correct answer verifies the member and clears the challenge', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));
    const challenge = await h.seed();

    const outcome = await h.submit(
      answerModal(challenge.challengeId),
      { [CODE]: challenge.answer },
      { config: CAPTCHA },
    );

    expect(outcome).toEqual({ action: 'verified' });
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, VERIFIED_ROLE]));
    expect(await h.captcha.get(GUILD, MEMBER)).toBeNull();
  });

  test('accepts the answer in any case and with stray spaces, as the message promises', async () => {
    const h = harness();
    const challenge = await h.seed();

    const outcome = await h.submit(
      answerModal(challenge.challengeId),
      { [CODE]: ` ${challenge.answer.toLowerCase()} ` },
      { config: CAPTCHA },
    );

    expect(outcome).toEqual({ action: 'verified' });
  });

  test('a wrong answer costs exactly one attempt and buys no extra time', async () => {
    const h = harness();
    const challenge = await h.seed();
    const deadline = h.captcha.expiryOf(GUILD, MEMBER);

    h.advance(60_000);
    const outcome = await h.submit(
      answerModal(challenge.challengeId),
      { [CODE]: 'WRONG1' },
      { config: CAPTCHA },
    );

    expect(outcome).toEqual({ action: 'failed', attemptsUsed: 1 });
    expect((await h.captcha.get(GUILD, MEMBER))?.attemptsUsed).toBe(1);
    expect(h.captcha.expiryOf(GUILD, MEMBER)).toBe(deadline);
    expect(h.roleCalls()).toEqual([]);
  });

  test('answers a wrong code with a message, never with a second modal', async () => {
    const h = harness();
    const challenge = await h.seed();

    await h.submit(answerModal(challenge.challengeId), { [CODE]: 'WRONG1' }, { config: CAPTCHA });

    expect(h.callbackTypes()).toEqual([4]);
    expect(h.lastTold()).toContain('That is not the code in the image.');
    expect(h.button('Enter code').customId).toBe(captchaPress(challenge.challengeId));
  });

  test('counts down the attempts it has left in the words the member reads', async () => {
    const h = harness();
    const challenge = await h.seed();

    await h.submit(answerModal(challenge.challengeId), { [CODE]: 'WRONG1' }, { config: CAPTCHA });
    expect(h.lastTold()).toContain('You have one more attempt after this one.');

    await h.submit(answerModal(challenge.challengeId), { [CODE]: 'WRONG2' }, { config: CAPTCHA });
    expect(h.lastTold()).toContain('This is your last attempt.');
  });

  test('an expired challenge is refused without burning an attempt', async () => {
    const h = harness();
    const challenge = await h.seed({ attemptsUsed: 1 });

    h.advance(CAPTCHA_TTL_MS);
    const outcome = await h.submit(
      answerModal(challenge.challengeId),
      { [CODE]: challenge.answer },
      { config: CAPTCHA },
    );

    expect(outcome).toEqual({
      action: 'refused',
      reason: 'the challenge is gone or has been replaced',
    });
    expect(h.lastTold()).toContain('expired or been replaced');
    expect(h.captcha.updates).toBe(0);
  });

  test('a replaced challenge is refused without burning an attempt on the live one', async () => {
    const h = harness();
    const stale = await h.seed();
    const live = await h.seed();

    const outcome = await h.submit(
      answerModal(stale.challengeId),
      { [CODE]: stale.answer },
      { config: CAPTCHA },
    );

    expect(outcome.action).toBe('refused');
    expect((await h.captcha.get(GUILD, MEMBER))?.challengeId).toBe(live.challengeId);
    expect((await h.captcha.get(GUILD, MEMBER))?.attemptsUsed).toBe(0);
  });

  test('leaves another module’s modal alone', async () => {
    const h = harness();

    const outcome = await h.submit('proton:tickets:close', { reason: 'done' }, { config: CAPTCHA });

    expect(outcome).toEqual({ action: 'ignored', reason: 'another module owns that modal' });
    expect(h.rest.calls).toEqual([]);
  });
});

describe('the Different image press', () => {
  test('draws a new answer but keeps the attempts spent and the deadline set', async () => {
    const h = harness();
    const challenge = await h.seed({ attemptsUsed: 1 });
    const deadline = h.captcha.expiryOf(GUILD, MEMBER);

    h.advance(30_000);
    const outcome = await h.press(refreshPress(challenge.challengeId), { config: CAPTCHA });

    const replacement = await h.captcha.get(GUILD, MEMBER);
    expect(outcome).toEqual({ action: 'challenged', challengeId: replacement?.challengeId ?? '' });
    expect(replacement?.challengeId).not.toBe(challenge.challengeId);
    expect(replacement?.answer).toBe(h.rendered.at(-1) ?? '');

    expect(replacement?.attemptsUsed).toBe(1);
    expect(h.captcha.expiryOf(GUILD, MEMBER)).toBe(deadline);
    expect(h.captcha.puts).toBe(1);
  });

  test('the replacement image comes with buttons that carry the replacement’s id', async () => {
    const h = harness();
    const challenge = await h.seed();

    await h.press(refreshPress(challenge.challengeId), { config: CAPTCHA });
    const replacement = await h.captcha.get(GUILD, MEMBER);

    expect(h.button('Enter code').customId).toBe(captchaPress(replacement?.challengeId ?? ''));
    expect(
      h
        .shown()
        .at(-1)
        ?.files.map((file) => file.filename),
    ).toEqual(['captcha.png']);
  });

  test('refuses a stale id rather than minting a challenge nobody asked for', async () => {
    const h = harness();
    const stale = await h.seed();
    const live = await h.seed();

    const outcome = await h.press(refreshPress(stale.challengeId), { config: CAPTCHA });

    expect(outcome.action).toBe('refused');
    expect((await h.captcha.get(GUILD, MEMBER))?.challengeId).toBe(live.challengeId);
  });
});

describe('captchaDelivery: dm', () => {
  test('opens a DM, sends the image into it, and points the member at their DMs', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), {
      config: { ...CAPTCHA, captchaDelivery: 'dm' },
    });

    expect(outcome.action).toBe('challenged');
    expect(h.dmOpens()).toHaveLength(1);
    expect(h.sentIn(DM_CHANNEL)).toHaveLength(1);
    expect(h.lastTold()).toContain('sent your captcha by direct message');
  });

  test('a closed DM refuses the send, not the open, and still gets the member their captcha', async () => {
    const h = harness();
    h.rest.fail((call) => call.path === `/channels/${DM_CHANNEL}/messages`, CLOSED_DM);

    const outcome = await h.press(verifyPress(), {
      config: { ...CAPTCHA, captchaDelivery: 'dm' },
    });

    expect(outcome.action).toBe('challenged');
    expect(h.dmOpens()).toHaveLength(1);

    const delivered = h.shown().at(-1);
    expect(delivered?.files).toEqual([{ filename: 'captcha.png', data: CAPTCHA_PNG }]);
    expect(h.button('Enter code').customId).not.toBeNull();
  });

  test('a DM channel Discord refuses to open falls back the same way', async () => {
    const h = harness();
    h.rest.fail((call) => call.path === '/users/@me/channels', {
      status: 400,
      body: { message: 'Bad Request' },
    });

    await h.press(verifyPress(), { config: { ...CAPTCHA, captchaDelivery: 'dm' } });

    expect(h.sentIn(DM_CHANNEL)).toEqual([]);
    expect(h.shown().at(-1)?.files).toHaveLength(1);
  });
});
