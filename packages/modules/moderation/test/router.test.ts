import { describe, expect, test } from 'bun:test';
import { UNKNOWN_CONTROL } from '../src/interactions/router.ts';
import { DRAFTS_UNBOUND, MODERATION_OFF } from '../src/punish/pending.ts';
import { modalEvent, pressEvent } from './drivers.ts';
import { harness } from './harness.ts';
import { textOf } from './reports-setup.ts';

const DEFERRED_UPDATE = 6;

describe('the moderation interaction router', () => {
  test('ignores a control another module owns without answering it', async () => {
    const h = harness();

    expect(await h.listen(pressEvent('proton:tickets:close:abc'))).toBe(1);
    expect(h.rest.calls).toEqual([]);
  });

  test('ignores a custom id that is not Proton’s', async () => {
    const h = harness();

    await h.listen(pressEvent('some-other-bot:button'));

    expect(h.rest.calls).toEqual([]);
  });

  test('tells the presser Moderation is off instead of running the handler', async () => {
    const h = harness();

    await h.listen(pressEvent('proton:moderation:rclaim:Xk3P9aQ'), undefined, {
      config: { enabled: false },
    });

    const [reply] = h.replies();
    expect(h.replies()).toHaveLength(1);
    expect(textOf(reply)).toContain(MODERATION_OFF);
    expect(h.statusOf(reply)).toBe('error');
    expect(h.callbackTypes()).not.toContain(DEFERRED_UPDATE);
  });

  test('answers a moderation control it has no handler for rather than staying silent', async () => {
    const h = harness();

    await h.listen(pressEvent('proton:moderation:retired:1'));

    const [reply] = h.replies();
    expect(textOf(reply)).toContain(UNKNOWN_CONTROL);
    expect(h.statusOf(reply)).toBe('error');
    expect(h.logs.some((log) => log.level === 'warn' && log.message.includes("'retired'"))).toBe(
      true,
    );
  });

  test('an unknown modal is answered the same way', async () => {
    const h = harness();

    await h.listen(modalEvent('proton:moderation:retired:1'));

    expect(textOf(h.replies()[0])).toContain(UNKNOWN_CONTROL);
  });

  test('hands a punish control to the punish flow', async () => {
    const h = harness();

    await h.listen(pressEvent('proton:moderation:pgo:abcdefghij'));

    expect(textOf(h.replies()[0])).toContain(DRAFTS_UNBOUND);
  });

  test('hands a card button to report review', async () => {
    const h = harness();

    await h.listen(pressEvent('proton:moderation:rclaim:Xk3P9aQ'));

    expect(h.callbackTypes()[0]).toBe(DEFERRED_UPDATE);
  });
});
