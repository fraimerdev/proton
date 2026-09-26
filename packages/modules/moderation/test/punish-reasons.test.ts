import { describe, expect, test } from 'bun:test';
import { punishConfigSchema } from '../src/punish/config.ts';
import { expandReason, reasonChoices } from '../src/punish/reasons.ts';
import { automation, executed, kit, request } from './punish-kit.ts';

const LONG = `${'Repeatedly posting scam links after a warning. '.repeat(3)}`.trim();

const PUNISH = punishConfigSchema.parse({
  reasons: [
    { id: 'spam', reason: 'Spamming the chat', aliases: ['sp', 'flood'] },
    { id: 'Scam', reason: LONG, aliases: ['scamlink'] },
    { id: 'nsfw', reason: 'Inappropriate content' },
  ],
});

describe('expandReason', () => {
  test('a whole alias, in any case, becomes its predefined reason', () => {
    expect(expandReason(PUNISH, 'flood')).toBe('Spamming the chat');
    expect(expandReason(PUNISH, '  SP ')).toBe('Spamming the chat');
  });

  test('a reason id expands too, which is what a long autocomplete choice sends', () => {
    expect(expandReason(PUNISH, 'scam')).toBe(LONG);
    expect(expandReason(PUNISH, 'NSFW')).toBe('Inappropriate content');
  });

  test('anything that is not a whole alias or id is kept as typed', () => {
    expect(expandReason(PUNISH, 'spam again')).toBe('spam again');
    expect(expandReason(PUNISH, 'floo')).toBe('floo');
    expect(expandReason(PUNISH, '  Just rude  ')).toBe('Just rude');
  });
});

describe('reasonChoices', () => {
  test('an empty query lists every reason, a long one travelling as its first alias', () => {
    const choices = reasonChoices(PUNISH, '');

    expect(choices.map((choice) => choice.value)).toEqual([
      'Spamming the chat',
      'scamlink',
      'Inappropriate content',
    ]);
    expect(choices[1]?.name.length).toBeLessThanOrEqual(100);
    expect(choices[1]?.name.endsWith('…')).toBe(true);
  });

  test('matches an alias prefix or a substring of the reason', () => {
    expect(reasonChoices(PUNISH, 'flo').map((choice) => choice.value)).toEqual([
      'Spamming the chat',
    ]);
    expect(reasonChoices(PUNISH, 'content').map((choice) => choice.value)).toEqual([
      'Inappropriate content',
    ]);
  });

  test('a long reason with no alias travels as its id', () => {
    const bare = punishConfigSchema.parse({ reasons: [{ id: 'long', reason: LONG }] });
    expect(reasonChoices(bare, '')).toEqual([{ name: expect.any(String), value: 'long' }]);
  });
});

describe('reasons inside punish()', () => {
  test('an alias typed by the moderator lands on the case as the full reason', async () => {
    const k = kit({
      config: { punish: { reasons: [{ id: 'spam', reason: 'Spamming the chat' }] } },
    });

    const outcome = executed(await k.run(request('warn', { reason: 'SPAM' })));

    expect(outcome.reason).toBe('Spamming the chat');
    expect(k.h.cases()[0]?.reason).toBe('Spamming the chat');
  });

  test('an empty reason falls back to the kind’s default reason', async () => {
    const k = kit({
      config: { punish: { types: { kick: { defaultReason: 'Breaking the rules' } } } },
    });

    const outcome = executed(await k.run(request('kick')));

    expect(outcome.reason).toBe('Breaking the rules');
    expect(k.h.cases()[0]?.reason).toBe('Breaking the rules');
  });

  test('forceReason refuses a moderator who gave none, naming the verb', async () => {
    const k = kit({ config: { punish: { types: { timeout: { forceReason: true } } } } });

    const outcome = await k.run(request('timeout'));

    expect(outcome).toEqual({
      status: 'refused',
      code: 'reason_required',
      message: expect.stringContaining('requires a reason to time out members'),
    });
    expect(k.h.discordCalls()).toHaveLength(0);
  });

  test('forceReason is per type: a forced ban does not force a warning', async () => {
    const k = kit({ config: { punish: { types: { ban: { forceReason: true } } } } });

    expect((await k.run(request('warn'))).status).toBe('executed');
    expect((await k.run(request('ban', { idempotencyRoot: 'evt-2' }))).status).toBe('refused');
  });

  test('forceReason never refuses automation, which uses the default reason instead', async () => {
    const k = kit({
      config: { punish: { types: { warn: { forceReason: true, defaultReason: 'Reported' } } } },
    });

    const outcome = executed(await k.run(request('warn', { actor: automation() })));

    expect(outcome.reason).toBe('Reported');
  });

  test('a reason longer than 512 characters is clipped rather than refused by the executor', async () => {
    const k = kit();

    const outcome = executed(await k.run(request('warn', { reason: 'x'.repeat(700) })));

    expect(outcome.reason).toHaveLength(512);
  });
});
