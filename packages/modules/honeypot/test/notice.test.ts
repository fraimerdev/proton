import { describe, expect, test } from 'bun:test';
import { HONEYPOT_COLOUR } from '../src/embed.ts';
import { armed, harness, LOUNGE, TRAP } from './harness.ts';

describe('the notice request', () => {
  test('posts the warning into the honeypot channel it names', async () => {
    const h = harness();

    const outcome = await h.notice({ config: armed() });

    expect(outcome).toEqual({ action: 'posted', channelId: TRAP });
    expect(h.calls()).toEqual([`POST /channels/${TRAP}/messages`]);

    const embed = h.embedIn(TRAP);
    expect(embed?.title).toContain('Do not send messages in this channel');
    expect(embed?.color).toBe(HONEYPOT_COLOUR);
    expect(String(embed?.description)).toContain('There is never a reason to post here.');
  });

  test('mentions nobody, so a trap notice cannot ping the server', async () => {
    const h = harness();

    await h.notice({ config: armed() });

    expect(h.sentIn(TRAP).at(-1)?.allowed_mentions).toEqual({ parse: [] });
  });

  test('states the window that row is actually configured with', async () => {
    const h = harness();

    await h.notice({ config: armed({ deleteMessageSeconds: 86_400 }) });

    expect(h.embedIn(TRAP)?.fields).toEqual([
      {
        name: 'Messages deleted',
        value: 'Everything you posted in the last day',
        inline: true,
      },
    ]);
  });

  test('promises no purge for an action that deletes nothing', async () => {
    const h = harness();

    await h.notice({ config: armed({ action: 'kick' }) });

    const embed = h.embedIn(TRAP);
    expect(embed?.fields).toBeUndefined();
    expect(String(embed?.description)).toContain('you will be removed from the server.');
  });

  test('refuses a channel that is not a honeypot, and posts nothing', async () => {
    const h = harness();

    const outcome = await h.notice({ config: armed(), channelId: LOUNGE });

    expect(outcome).toEqual({
      action: 'refused',
      reason: `<#${LOUNGE}> is not a honeypot channel, so there is no notice to post in it.`,
    });
    expect(h.calls()).toEqual([]);
  });

  test('refuses a request it cannot read, and says it is a mismatch not a misconfiguration', async () => {
    const h = harness();

    const outcome = await h.notice({ config: armed(), payload: { channelId: TRAP } });

    expect(outcome).toEqual({ action: 'ignored', reason: 'unreadable notice request' });
    expect(h.calls()).toEqual([]);
    expect(h.said('error').at(-1)).toContain('api/module mismatch');
  });

  test('reports what Discord said when the post is refused', async () => {
    const h = harness();
    h.rest.fail((call) => call.path === `/channels/${TRAP}/messages`, {
      status: 403,
      body: { message: 'Missing Access' },
    });

    const outcome = await h.notice({ config: armed() });

    expect(outcome.action).toBe('refused');
    expect(h.said('error').at(-1)).toContain('Missing Access');
  });

  test('is not a moderation case — nobody was acted on', async () => {
    const h = harness();

    await h.notice({ config: armed() });

    expect(h.cases()).toEqual([]);
  });
});
